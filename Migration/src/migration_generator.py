#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SYSTEM_PROMPT = "You are a helpful java project migration assistant"
DEFAULT_MODEL = "gpt-4o-mini"

# Build prompt 
def make_APIMig_prompt(
    Library_Name,
    Target_Code_Snippet,
    Callisite,
    Change_information,
    Source_Version,
    Target_Version,
    Method_Body=None,
    include_method_body=False,
):
    method_body_section = ""
    if include_method_body:
        method_body_section = f"""
### The method body to which the code snippet belongs ###
{Method_Body or ""}"""

    prompt = f"""
        ### Task Instructions ###    
        I update my Java project's dependency Library {Library_Name} from version {Source_Version} to {Target_Version}.
        I will provide you with the Code Snippet that has API call problems due to version change. Your task is to modify the Code Snippet based on the information given.

        ### Target Code Snippet ###
        This is the code that need to migrate, containing the Changed API and Dependent code statements:
        {Target_Code_Snippet}

        ### The method body to which the code snippet belongs ###
        {method_body_section}

        ### API Callsite ###
        the statements containing the changed API callsite:
        {Callisite}

        ### API Change information description ###
        <change source element, type, change target element> [scope],[Description]
        {Change_information}
        Migrate the “Target Code Snippet” to target version according the given API Change information. Only return the Migrated Code, start with ###START###, end with ###END###.
    """
    return prompt.strip()

# Runs callsite analysis first, converts each CEA block to one migration task,
def generate_migration_from_path(input_path, migration_spec, execute=False):
    normalized_spec = normalize_migration_spec(migration_spec, execute)
    callsite_analysis = normalized_spec.get("callsiteAnalysis") or analyze_callsites_with_node(
        input_path,
        normalized_spec["changeSpec"],
    )
    project_graph = build_graph_with_node(input_path) if normalized_spec["includeMethodBody"] else None
    tasks = build_migration_tasks(project_graph, callsite_analysis, normalized_spec)

    result = {
        "meta": build_migration_meta(input_path, callsite_analysis, normalized_spec, tasks),
        "callsiteAnalysis": callsite_analysis,
        "tasks": tasks,
    }

    if normalized_spec["execute"]:
        result["results"] = [execute_migration_task(task, normalized_spec) for task in tasks]
        result["meta"]["status"] = "executed"
        result["meta"]["resultCount"] = len(result["results"])

    return result

# Convert CEA output blocks into model-ready task records.
def build_migration_tasks(project_graph, callsite_analysis, migration_spec):
    graph_context = build_graph_context(project_graph) if project_graph else None
    blocks = callsite_analysis.get("callsiteBlocks", [])
    tasks = []

    for index, block in enumerate(blocks):
        # The target snippet is the exact code region that should be migrated.
        target_code_snippet = format_target_code_snippet(block)
        callsite_text = (block.get("callsite") or {}).get("text") or ""
        method_body = find_enclosing_callable_text(graph_context, (block.get("callsite") or {}).get("nodeId"))
        prompt = make_APIMig_prompt(
            Library_Name=migration_spec["libraryName"],
            Target_Code_Snippet=target_code_snippet,
            Method_Body=method_body,
            Callisite=callsite_text,
            Change_information=migration_spec["changeInformation"],
            Source_Version=migration_spec["sourceVersion"],
            Target_Version=migration_spec["targetVersion"],
            include_method_body=migration_spec["includeMethodBody"],
        )

        tasks.append({
            "taskIndex": index,
            "changeIndex": block.get("changeIndex", 0),
            "granularity": block.get("granularity"),
            "scope": block.get("scope"),
            "role": block.get("role"),
            "filePath": (block.get("callsite") or {}).get("filePath"),
            "target": block.get("target"),
            "block": block,
            "targetCodeSnippet": target_code_snippet,
            "methodBody": method_body,
            "callsite": callsite_text,
            "prompt": prompt,
        })

    return tasks

# Normalize
def normalize_migration_spec(migration_spec, execute):
    change_spec = migration_spec.get("changeSpec")
    if change_spec is None:
        change_spec = {"changes": migration_spec["changes"]} if "changes" in migration_spec else migration_spec.get("callsiteSpec", migration_spec)

    return {
        "libraryName": migration_spec.get("libraryName"),
        "sourceVersion": migration_spec.get("sourceVersion"),
        "targetVersion": migration_spec.get("targetVersion"),
        "changeInformation": migration_spec.get("changeInformation") or "",
        "includeMethodBody": migration_spec.get("includeMethodBody") is True,
        "execute": execute or migration_spec.get("execute") is True,
        "model": migration_spec.get("model") or os.environ.get("MIGRATION_MODEL") or DEFAULT_MODEL,
        "baseUrl": migration_spec.get("baseUrl") or os.environ.get("MIGRATION_BASE_URL") or "https://api.openai.com/v1",
        "apiKey": migration_spec.get("apiKey") or os.environ.get("MIGRATION_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        "temperature": migration_spec.get("temperature", 0.7),
        "maxTokens": migration_spec.get("maxTokens", 512),
        "systemPrompt": migration_spec.get("systemPrompt") or DEFAULT_SYSTEM_PROMPT,
        "callsiteAnalysis": migration_spec.get("callsiteAnalysis"),
        "changeSpec": change_spec,
    }

# Run the existing JS callsite-analysis pipeline and parse its JSON output.
def analyze_callsites_with_node(input_path, change_spec):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as spec_file:
        json.dump(change_spec, spec_file)
        spec_file_path = spec_file.name

    try:
        return run_node_json([str(input_path), "--change-spec", spec_file_path])
    finally:
        Path(spec_file_path).unlink(missing_ok=True)


def build_graph_with_node(input_path):
    return run_node_json([str(input_path)])

# Execute the Node CLI from Python and return its JSON payload.
def run_node_json(args):
    repo_root = Path(__file__).resolve().parents[1]
    command = ["node", str(repo_root / "src" / "cli.js"), *args]
    completed = subprocess.run(
        command,
        cwd=repo_root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"Node command failed: {' '.join(command)}")
    return json.loads(completed.stdout)

# Merge the three CEA regions into one prompt snippet in dependency order.
def format_target_code_snippet(block):
    lines = []
    lines.extend(format_node_list("Before Callsite", block.get("beforeCallsite", [])))
    lines.extend(format_node_list("Callsite", [block.get("callsite")]))
    lines.extend(format_node_list("After Callsite", block.get("afterCallsite", [])))
    return "\n".join(lines)

# Format a named group of graph nodes, omitting empty groups to keep prompts short.
def format_node_list(label, nodes):
    filtered_nodes = [node for node in nodes if node]
    if not filtered_nodes:
        return []
    return [f"// {label}", *[(node.get("text") or "") for node in filtered_nodes]]


def build_graph_context(graph):
    node_map = {node["id"]: node for node in graph.get("nodes", [])}
    incoming_edges_by_target = {}
    for edge in graph.get("edges", []):
        incoming_edges_by_target.setdefault(edge.get("target"), []).append(edge)
    return {
        "nodeMap": node_map,
        "incomingEdgesByTarget": incoming_edges_by_target,
    }


def find_enclosing_callable_text(context, node_id):
    if not context or not node_id:
        return None

    node = context["nodeMap"].get(node_id)
    if node and node.get("type") in {"method_declaration", "constructor_declaration"}:
        return node.get("text")

    callable_node = find_enclosing_node_by_types(context, node_id, {"method_declaration", "constructor_declaration"})
    return callable_node.get("text") if callable_node else None


def find_enclosing_node_by_types(context, node_id, target_types):
    incoming_edges = context["incomingEdgesByTarget"].get(node_id, [])
    hierarchy_parent_edge = next(
        (edge for edge in incoming_edges if edge.get("kind") == "str" and edge.get("relation") == "hierarchy"),
        None,
    )
    if not hierarchy_parent_edge:
        return None

    parent_node = context["nodeMap"].get(hierarchy_parent_edge.get("source"))
    if not parent_node:
        return None
    if parent_node.get("type") in target_types:
        return parent_node
    return find_enclosing_node_by_types(context, parent_node.get("id"), target_types)


# Execute one migration prompt and keep both the raw response and parsed snippet.
def execute_migration_task(task, migration_spec):
    response_text = ask_openai_compatible(task["prompt"], migration_spec)
    return {
        "taskIndex": task["taskIndex"],
        "changeIndex": task["changeIndex"],
        "filePath": task["filePath"],
        "responseText": response_text,
        "migratedCodeSnippet": extract_delimited_snippet(response_text),
    }


def ask_openai_compatible(content, migration_spec):
    api_key = migration_spec.get("apiKey")
    if not api_key:
        raise RuntimeError("Missing API key. Set MIGRATION_API_KEY or OPENAI_API_KEY, or run without --execute-migration.")

    payload = {
        "model": migration_spec["model"],
        "messages": [
            {"role": "system", "content": migration_spec["systemPrompt"]},
            {"role": "user", "content": content},
        ],
        "temperature": migration_spec["temperature"],
        "max_tokens": migration_spec["maxTokens"],
    }
    url = migration_spec["baseUrl"].rstrip("/") + "/chat/completions"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    # Surface provider errors with the response body because migration failures
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Migration model request failed: {error.code} {error.read().decode('utf-8')}") from error

    choices = response_payload.get("choices") or []
    if not choices:
        return ""
    return ((choices[0].get("message") or {}).get("content")) or ""


def ask_gpt(content):
    spec = {
        "apiKey": os.environ.get("OPENAI_API_KEY") or os.environ.get("MIGRATION_API_KEY"),
        "baseUrl": os.environ.get("MIGRATION_BASE_URL", "https://api.openai.com/v1"),
        "model": os.environ.get("MIGRATION_MODEL", DEFAULT_MODEL),
        "systemPrompt": DEFAULT_SYSTEM_PROMPT,
        "temperature": 0.7,
        "maxTokens": 512,
    }
    return ask_openai_compatible(content, spec)

# Extract the migrated snippet required by the prompt contract.
def extract_delimited_snippet(response_text):
    match = re.search(r"###START###([\s\S]*?)###END###", response_text or "")
    return match.group(1).strip() if match else None

# Summarize the migration generation run for downstream scripts.
def build_migration_meta(input_path, callsite_analysis, migration_spec, tasks):
    callsite_meta = callsite_analysis.get("meta", {})
    return {
        "status": "prompt-only",
        "language": callsite_meta.get("language", "java"),
        "rootPath": callsite_meta.get("rootPath") or str(Path(input_path).resolve()),
        "libraryName": migration_spec["libraryName"],
        "sourceVersion": migration_spec["sourceVersion"],
        "targetVersion": migration_spec["targetVersion"],
        "callsiteBlockCount": len(callsite_analysis.get("callsiteBlocks", [])),
        "taskCount": len(tasks),
        "resultCount": 0,
        "model": migration_spec["model"] if migration_spec["execute"] else None,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate Java API migration prompts from CEA callsite blocks.")
    parser.add_argument("input_path", help="Java source file or project directory")
    parser.add_argument("--migration-spec", required=True, help="Migration specification JSON file")
    parser.add_argument("--execute-migration", action="store_true", help="Call an OpenAI-compatible model")
    args = parser.parse_args()

    with open(args.migration_spec, "r", encoding="utf-8") as spec_file:
        migration_spec = json.load(spec_file)

    result = generate_migration_from_path(args.input_path, migration_spec, args.execute_migration)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
