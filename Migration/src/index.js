import fs from "node:fs";
import path from "node:path";
import { analyzeJavaSource, buildJavaProjectGraph } from "./graph-builder.js";
import { buildSymbolIndex, linkProjectSemanticEdges } from "./project-resolver.js";

export { buildJavaProjectGraph } from "./graph-builder.js";

// Build a heterogeneous graph for one Java source file.
export function buildGraphFromFile(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const sourceCode = fs.readFileSync(absolutePath, "utf8");
  return buildJavaProjectGraph(sourceCode, {
    ...options,
    filePath: absolutePath,
  });
}

// Build a project graph from a directory and return only the graph payload.
export function buildGraphFromDirectory(directoryPath, options = {}) {
  return analyzeProjectFromDirectory(directoryPath, options).graph;
}

// Analyze a Java directory once and keep graph, facts, and symbol index together.
export function analyzeProjectFromDirectory(directoryPath, options = {}) {
  const absolutePath = path.resolve(directoryPath);
  const javaFiles = collectJavaFiles(absolutePath);
  const projectId = `project:${absolutePath}`;
  const analyzedFiles = [];
  const nodes = [
    {
      id: projectId,
      category: "structure",
      type: "project",
      filePath: absolutePath,
      text: path.basename(absolutePath),
      range: null,
      order: 0,
    },
  ];
  const edges = [];
  let order = 1;

  for (const javaFile of javaFiles) {
    const sourceCode = fs.readFileSync(javaFile, "utf8");
    const analyzedFile = analyzeJavaSource(sourceCode, {
      ...options,
      filePath: javaFile,
    });
    analyzedFiles.push(analyzedFile);

    const fileGraph = analyzedFile.graph;
    const fileId = `file:${javaFile}`;
    nodes.push({
      id: fileId,
      category: "structure",
      type: "source_file",
      filePath: javaFile,
      text: path.relative(absolutePath, javaFile),
      range: null,
      order: order++,
    });
    edges.push({
      id: `str:${projectId}->${fileId}:contains-file:`,
      kind: "str",
      source: projectId,
      target: fileId,
      relation: "contains-file",
    });

    if (fileGraph.meta.rootNodeId) {
      edges.push({
        id: `str:${fileId}->${fileGraph.meta.rootNodeId}:contains-root:`,
        kind: "str",
        source: fileId,
        target: fileGraph.meta.rootNodeId,
        relation: "contains-root",
      });
    }

    for (const node of fileGraph.nodes) {
      nodes.push({
        ...node,
        order: order++,
      });
    }
    edges.push(...fileGraph.edges);
  }

  const projectSemanticEdges = linkProjectSemanticEdges(analyzedFiles);
  edges.push(...projectSemanticEdges);
  const symbolIndex = buildSymbolIndex(analyzedFiles);

  const graph = {
    meta: {
      language: "java",
      rootPath: absolutePath,
      fileCount: javaFiles.length,
      semanticEdgeCount: projectSemanticEdges.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    nodes,
    edges,
  };

  return {
    graph,
    analyzedFiles,
    symbolIndex,
    projectSemanticEdges,
  };
}

// Route a path to either single-file or directory graph construction.
export function buildGraphFromPath(inputPath, options = {}) {
  const absolutePath = path.resolve(inputPath);
  const stat = fs.statSync(absolutePath);
  return stat.isDirectory()
    ? analyzeProjectFromDirectory(absolutePath, options).graph
    : buildGraphFromFile(absolutePath, options);
}

// Route a path to the richer project-analysis result used by higher-level analyses.
export function analyzeProjectFromPath(inputPath, options = {}) {
  const absolutePath = path.resolve(inputPath);
  const stat = fs.statSync(absolutePath);
  return stat.isDirectory()
    ? analyzeProjectFromDirectory(absolutePath, options)
    : analyzeSingleFileProject(absolutePath, options);
}

// Summarize node and edge counts for quick inspection.
export function summarizeGraph(graph) {
  const nodeCategoryCounts = countBy(graph.nodes, "category");
  const nodeTypeCounts = countBy(graph.nodes, "type");
  const edgeKindCounts = countBy(graph.edges, "kind");

  return {
    meta: graph.meta,
    nodeCategoryCounts,
    edgeKindCounts,
    topNodeTypes: Object.entries(nodeTypeCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([type, count]) => ({ type, count })),
  };
}

// Wrap a single file in the same analysis shape used for project directories.
function analyzeSingleFileProject(filePath, options) {
  const sourceCode = fs.readFileSync(filePath, "utf8");
  const analyzedFile = analyzeJavaSource(sourceCode, {
    ...options,
    filePath,
  });
  const symbolIndex = buildSymbolIndex([analyzedFile]);

  return {
    graph: analyzedFile.graph,
    analyzedFiles: [analyzedFile],
    symbolIndex,
    projectSemanticEdges: [],
  };
}

// Recursively collect Java files while skipping generated or IDE directories.
function collectJavaFiles(rootDirectory) {
  const javaFiles = [];
  const pending = [rootDirectory];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const absoluteEntryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".idea" || entry.name === "target" || entry.name === "build") {
          continue;
        }
        pending.push(absoluteEntryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".java")) {
        javaFiles.push(absoluteEntryPath);
      }
    }
  }

  javaFiles.sort();
  return javaFiles;
}

// Count occurrences of items grouped by one property.
function countBy(items, key) {
  return Object.fromEntries(
    items.reduce((map, item) => {
      const value = item[key];
      map.set(value, (map.get(value) ?? 0) + 1);
      return map;
    }, new Map()),
  );
}
