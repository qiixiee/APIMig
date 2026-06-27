import fs from "node:fs";
import { analyzeProjectFromPath } from "./index.js";

const STATEMENT_TYPES_WITH_RETURN_CARRIER = new Set([
  "local_variable_declaration",
  "assignment_expression",
]);

// Type-reference relations used only by the Class/Interface Name rule.
const TYPE_USAGE_RELATIONS = new Set([
  "field-type",
  "local-type",
  "parameter-type",
  "return-type",
]);

// Analyze callsites for one path by first building the corresponding project analysis.
export function analyzeCallsitesFromPath(inputPath, changeSpec, options = {}) {
  const projectAnalysis = analyzeProjectFromPath(inputPath, options);
  return analyzeCallsites(projectAnalysis, changeSpec);
}

// Run rule-based callsite analysis for one or more API changes.
export function analyzeCallsites(projectAnalysis, changeSpec) {
  const changeSpecs = normalizeChangeSpecList(changeSpec);
  if (changeSpecs.length !== 1) {
    return analyzeBatchCallsites(projectAnalysis, changeSpecs);
  }

  const normalizedSpec = normalizeChangeSpec(changeSpecs[0]);
  const context = buildCallsiteContext(projectAnalysis);
  const analysis = analyzeOneChange(context, normalizedSpec, 0);

  if (!analysis.target) {
    return {
      meta: {
        status: "unresolved-target",
        ...normalizedSpec,
      },
      target: null,
      callsites: [],
      derivedImpactEdges: [],
      callsiteBlocks: [],
    };
  }

  const callsiteBlocks = exploreChangeChains(
    context,
    analysis.callsites,
    analysis.callsiteImpactMap,
    normalizedSpec,
    analysis.target,
  );

  return {
    meta: {
      status: "ok",
      language: projectAnalysis.graph.meta.language,
      rootPath: projectAnalysis.graph.meta.rootPath ?? null,
      fileCount: projectAnalysis.graph.meta.fileCount ?? 1,
      granularity: normalizedSpec.granularity,
      scope: normalizedSpec.scope,
      callsiteCount: analysis.callsites.length,
      derivedImpactEdgeCount: analysis.derivedImpactEdges.length,
      callsiteBlockCount: callsiteBlocks.length,
    },
    target: summarizeTarget(analysis.target),
    callsites: analysis.callsites.map((callsite) => summarizeCallsite(context, callsite)),
    derivedImpactEdges: analysis.derivedImpactEdges,
    callsiteBlocks,
  };
}

// Run all API changes through one shared CEA pass over the union of callsites.
export function analyzeBatchCallsites(projectAnalysis, changeSpecs) {
  const normalizedSpecs = normalizeChangeSpecList(changeSpecs).map(normalizeChangeSpec);
  const context = buildCallsiteContext(projectAnalysis);
  const allCallsites = [];
  const callsiteImpactMap = new Map();
  const derivedImpactEdges = [];
  const changes = [];

  normalizedSpecs.forEach((normalizedSpec, changeIndex) => {
    const analysis = analyzeOneChange(context, normalizedSpec, changeIndex);
    changes.push({
      changeIndex,
      status: analysis.target ? "ok" : "unresolved-target",
      granularity: normalizedSpec.granularity,
      scope: normalizedSpec.scope,
      target: analysis.target ? summarizeTarget(analysis.target) : null,
      callsiteCount: analysis.callsites.length,
      derivedImpactEdgeCount: analysis.derivedImpactEdges.length,
    });

    allCallsites.push(...analysis.callsites);
    for (const [key, impacts] of analysis.callsiteImpactMap.entries()) {
      callsiteImpactMap.set(key, impacts);
    }
    derivedImpactEdges.push(...analysis.derivedImpactEdges);
  });

  const callsiteBlocks = exploreChangeChains(context, allCallsites, callsiteImpactMap, null, null);

  return {
    meta: {
      status: "ok",
      language: projectAnalysis.graph.meta.language,
      rootPath: projectAnalysis.graph.meta.rootPath ?? null,
      fileCount: projectAnalysis.graph.meta.fileCount ?? 1,
      changeCount: normalizedSpecs.length,
      resolvedChangeCount: changes.filter((change) => change.status === "ok").length,
      callsiteCount: allCallsites.length,
      derivedImpactEdgeCount: derivedImpactEdges.length,
      callsiteBlockCount: callsiteBlocks.length,
    },
    changes,
    callsites: allCallsites.map((callsite) => summarizeCallsite(context, callsite)),
    derivedImpactEdges,
    callsiteBlocks,
  };
}

// Analyze one normalized change and collect callsites plus their impact nodes.
function analyzeOneChange(context, normalizedSpec, changeIndex) {
  const target = resolveTarget(context, normalizedSpec);

  if (!target) {
    return {
      target: null,
      callsites: [],
      derivedImpactEdges: [],
      callsiteImpactMap: new Map(),
    };
  }

  const callsites = identifyCallsites(context, normalizedSpec, target, changeIndex);
  const callsiteImpactMap = new Map();
  const derivedImpactEdges = [];

  for (const callsite of callsites) {
    const impactNodes = getImpactNodes(context, normalizedSpec, target, callsite);
    callsiteImpactMap.set(callsite.key, impactNodes);

    for (const impactNode of impactNodes) {
      derivedImpactEdges.push({
        source: callsite.nodeId,
        target: impactNode.nodeId,
        kind: impactNode.edgeType,
        reason: impactNode.reason,
        changeIndex,
      });
    }
  }

  return {
    target,
    callsites: callsites.map((callsite) => ({
      ...callsite,
      granularity: normalizedSpec.granularity,
      scope: normalizedSpec.scope,
      target,
    })),
    derivedImpactEdges,
    callsiteImpactMap,
  };
}

// Load a change specification from disk and run callsite analysis.
export function analyzeCallsitesFromSpecFile(inputPath, specPath, options = {}) {
  const changeSpec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  return analyzeCallsitesFromPath(inputPath, changeSpec, options);
}

// Accept either one spec, an array of specs, or an object with a changes array.
function normalizeChangeSpecList(changeSpec) {
  if (Array.isArray(changeSpec)) {
    return changeSpec;
  }
  if (Array.isArray(changeSpec?.changes)) {
    return changeSpec.changes;
  }
  return [changeSpec];
}

// Build lookup tables that make graph- and fact-based callsite queries cheap.
function buildCallsiteContext(projectAnalysis) {
  const { graph, analyzedFiles, symbolIndex } = projectAnalysis;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoingEdgesBySource = new Map();
  const incomingEdgesByTarget = new Map();

  for (const edge of graph.edges) {
    appendToList(outgoingEdgesBySource, edge.source, edge);
    appendToList(incomingEdgesByTarget, edge.target, edge);
  }

  const statementNodes = graph.nodes
    .filter((node) => node.category === "statement")
    .sort((left, right) => left.order - right.order);
  const statementNodeIds = new Set(statementNodes.map((node) => node.id));

  const fileFactsByPath = new Map(analyzedFiles.map((file) => [file.facts.filePath, file.facts]));
  const methodInvocationByNodeId = new Map();
  const typeFactByNodeId = new Map();
  const methodFactByNodeId = new Map();
  const constructorFactByNodeId = new Map();
  const importFactByNodeId = new Map();

  for (const analyzedFile of analyzedFiles) {
    const { facts } = analyzedFile;
    for (const invocation of facts.methodInvocations) {
      methodInvocationByNodeId.set(invocation.nodeId, invocation);
    }
    for (const typeFact of facts.types) {
      typeFactByNodeId.set(typeFact.nodeId, typeFact);
    }
    for (const methodFact of facts.methods) {
      methodFactByNodeId.set(methodFact.nodeId, methodFact);
    }
    for (const constructorFact of facts.constructors) {
      constructorFactByNodeId.set(constructorFact.nodeId, constructorFact);
    }
    for (const importFact of facts.imports) {
      importFactByNodeId.set(importFact.nodeId, importFact);
    }
  }

  return {
    graph,
    analyzedFiles,
    symbolIndex,
    nodeMap,
    outgoingEdgesBySource,
    incomingEdgesByTarget,
    statementNodes,
    statementNodeIds,
    fileFactsByPath,
    methodInvocationByNodeId,
    typeFactByNodeId,
    methodFactByNodeId,
    constructorFactByNodeId,
    importFactByNodeId,
  };
}

// Normalize user-facing change specs into internal tokens.
function normalizeChangeSpec(changeSpec) {
  const target = normalizeTargetSpec(changeSpec.target ?? changeSpec);
  const granularity = normalizeGranularity(changeSpec.granularity);
  const scope = normalizeScope(changeSpec.scope);
  return {
    granularity: granularity || inferGranularityFromTarget(target),
    scope,
    target,
  };
}

// Expand complete API signatures into owner/name/arity target fields.
function normalizeTargetSpec(targetSpec) {
  const expanded = parseApiSignature(targetSpec?.signature ?? targetSpec?.apiSignature);
  return {
    ...targetSpec,
    ...expanded,
  };
}

// Normalize granularity names while preserving the two supported compound labels.
function normalizeGranularity(value) {
  const normalized = normalizeBaseToken(value, false);
  if (normalized === "class-interface") {
    return "class/interface";
  }
  if (normalized === "method-constructor") {
    return "method/constructor";
  }
  if (normalized === "constant-variable") {
    return "constant/variable";
  }
  return normalized;
}

// Normalize scope names so rule matching can be done on stable tokens.
function normalizeScope(value) {
  return normalizeBaseToken(value, true);
}

// Convert mixed formatting like ReturnType or Extends/Implements into kebab case.
function normalizeBaseToken(value, replaceSlash) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .trim()
    .toLowerCase()
    .replace(replaceSlash ? /[\/_\s]+/g : /[_\s]+/g, "-");
}

// Infer the target granularity when the spec only provides a full signature.
function inferGranularityFromTarget(targetSpec) {
  return targetSpec?.name || targetSpec?.paramCount !== undefined
    ? "method/constructor"
    : "class/interface";
}

// Parse common complete-signature formats into owner, member name, and parameter count.
function parseApiSignature(signature) {
  if (!signature) {
    return {};
  }

  const trimmed = String(signature).trim();
  const openParenIndex = trimmed.indexOf("(");
  const closeParenIndex = trimmed.lastIndexOf(")");
  if (openParenIndex === -1 || closeParenIndex === -1 || closeParenIndex < openParenIndex) {
    return {
      qualifiedName: trimmed,
      simpleName: lastNameSegment(trimmed),
    };
  }

  const beforeParen = trimmed.slice(0, openParenIndex).trim();
  const parameterText = trimmed.slice(openParenIndex + 1, closeParenIndex).trim();
  const paramCount = parameterText ? splitTopLevel(parameterText, ",").length : 0;
  const parameterTypeNames = parameterText ? splitTopLevel(parameterText, ",").map(normalizeParameterTypeText) : [];
  const ownerAndName = beforeParen.split(/\s+/).at(-1);

  if (ownerAndName.includes("#")) {
    const [ownerQualifiedName, name] = ownerAndName.split("#");
    return {
      ownerQualifiedName,
      name: name === "<init>" ? null : name,
      kind: name === "<init>" ? "constructor" : "method",
      paramCount,
      parameterTypeNames,
    };
  }

  const lastDotIndex = ownerAndName.lastIndexOf(".");
  if (lastDotIndex === -1) {
    return {
      name: ownerAndName,
      paramCount,
      parameterTypeNames,
    };
  }

  const ownerQualifiedName = ownerAndName.slice(0, lastDotIndex);
  const name = ownerAndName.slice(lastDotIndex + 1);
  return {
    ownerQualifiedName,
    name: name === "<init>" ? null : name,
    kind: name === "<init>" ? "constructor" : "method",
    paramCount,
    parameterTypeNames,
  };
}

// Resolve the change target to either a type fact or a callable fact.
function resolveTarget(context, changeSpec) {
  if (changeSpec.granularity === "class/interface" || changeSpec.granularity === "class" || changeSpec.granularity === "interface") {
    return resolveTypeTarget(context, changeSpec.target);
  }

  if (changeSpec.granularity === "method/constructor" || changeSpec.granularity === "method" || changeSpec.granularity === "constructor") {
    return resolveCallableTarget(context, changeSpec.target);
  }

  if (changeSpec.granularity === "constant/variable" || changeSpec.granularity === "constant" || changeSpec.granularity === "variable") {
    return resolveVariableTarget(context, changeSpec.target);
  }

  return null;
}

// Resolve one source-defined field, local variable, parameter, or constant target.
function resolveVariableTarget(context, targetSpec) {
  const requiresConstant = targetSpec.kind === "constant" || targetSpec.isConstant === true;
  const candidates = targetSpec.nodeId
    ? context.symbolIndex.variablesByNodeId.get(targetSpec.nodeId) ?? []
    : context.symbolIndex.variablesByName.get(targetSpec.name) ?? [];
  const matches = candidates.filter((candidate) => {
    if (requiresConstant && !candidate.isConstant) {
      return false;
    }
    if (targetSpec.filePath && candidate.filePath !== targetSpec.filePath) {
      return false;
    }
    if (targetSpec.ownerQualifiedName && candidate.ownerQualifiedName !== targetSpec.ownerQualifiedName) {
      return false;
    }
    if (targetSpec.enclosingCallableNodeId && candidate.enclosingCallableNodeId !== targetSpec.enclosingCallableNodeId) {
      return false;
    }
    return !targetSpec.variableKind || candidate.kind === targetSpec.variableKind;
  });

  // A simple variable name is not a safe project-wide identity, so reject ambiguity.
  if (matches.length !== 1) {
    return null;
  }

  return {
    ...matches[0],
    variableKind: matches[0].kind,
    kind: "variable",
  };
}

// Resolve a class or interface target from qualified or simple names.
function resolveTypeTarget(context, targetSpec) {
  if (targetSpec.qualifiedName && context.symbolIndex.typeByQualifiedName.has(targetSpec.qualifiedName)) {
    const typeFact = context.symbolIndex.typeByQualifiedName.get(targetSpec.qualifiedName);
    return {
      ...typeFact,
      kind: "type",
    };
  }

  if (targetSpec.simpleName) {
    const matches = context.symbolIndex.typesBySimpleName.get(targetSpec.simpleName) ?? [];
    if (matches.length === 1) {
      return {
        ...matches[0],
        kind: "type",
      };
    }
  }

  const qualifiedName = targetSpec.qualifiedName ?? targetSpec.ownerQualifiedName ?? targetSpec.signature;
  if (qualifiedName) {
    return {
      kind: "type",
      external: true,
      nodeId: `external:type:${qualifiedName}`,
      qualifiedName,
      simpleName: targetSpec.simpleName ?? lastNameSegment(qualifiedName),
      filePath: null,
    };
  }

  return null;
}

// Resolve a method or constructor target from owner, name, and arity.
function resolveCallableTarget(context, targetSpec) {
  const ownerQualifiedName = targetSpec.ownerQualifiedName ?? targetSpec.qualifiedName;
  if (!ownerQualifiedName) {
    return null;
  }

  const kind = normalizeBaseToken(targetSpec.kind ?? "method", false);
  if (kind === "constructor" || !targetSpec.name) {
    const constructors = context.symbolIndex.constructorsByOwner.get(ownerQualifiedName) ?? [];
    if (typeof targetSpec.paramCount === "number") {
      const match = constructors.find((item) => item.paramCount === targetSpec.paramCount);
      if (match) {
        return {
          ...match,
          kind: "constructor",
        };
      }
    }
    if (constructors.length > 0) {
      return {
        ...constructors[0],
        kind: "constructor",
      };
    }
    return {
      kind: "constructor",
      external: true,
      nodeId: `external:constructor:${ownerQualifiedName}/${targetSpec.paramCount ?? "*"}`,
      ownerQualifiedName,
      name: null,
      paramCount: targetSpec.paramCount,
      parameterTypeNames: targetSpec.parameterTypeNames ?? [],
      filePath: null,
    };
  }

  const methods = context.symbolIndex.methodsByOwner.get(ownerQualifiedName) ?? [];
  if (typeof targetSpec.paramCount === "number") {
    const exact = methods.find((item) => item.name === targetSpec.name && item.paramCount === targetSpec.paramCount);
    if (exact) {
      return {
        ...exact,
        kind: "method",
      };
    }
  }

  const nameOnly = methods.find((item) => item.name === targetSpec.name);
  return nameOnly
    ? {
        ...nameOnly,
        kind: "method",
      }
    : {
        kind: "method",
        external: true,
        nodeId: `external:method:${ownerQualifiedName}#${targetSpec.name}/${targetSpec.paramCount ?? "*"}`,
        ownerQualifiedName,
        name: targetSpec.name,
        paramCount: targetSpec.paramCount,
        parameterTypeNames: targetSpec.parameterTypeNames ?? [],
        filePath: null,
      };
}

// Collect all callsite entries that match the target and change scope.
function identifyCallsites(context, changeSpec, target, changeIndex = 0) {
  const entries = [];
  const seen = new Set();

  if (target.kind === "type") {
    identifyTypeCallsites(context, changeSpec, target, entries, seen, changeIndex);
  } else if (target.kind === "variable") {
    identifyVariableCallsites(context, target, entries, seen, changeIndex);
  } else {
    identifyCallableCallsites(context, changeSpec, target, entries, seen, changeIndex);
  }

  return entries.sort((left, right) => {
    const leftNode = context.nodeMap.get(left.nodeId);
    const rightNode = context.nodeMap.get(right.nodeId);
    return (leftNode?.order ?? 0) - (rightNode?.order ?? 0);
  });
}

// Identify the declaration and all lexically scoped statement-level uses of a variable.
function identifyVariableCallsites(context, target, entries, seen, changeIndex) {
  for (const nodeId of collectVariableUsageStatements(context, target)) {
    addCallsite(entries, seen, {
      nodeId,
      role: "variable-usage",
      reason: nodeId === target.nodeId ? "variable-declaration" : "variable-usage",
      changeIndex,
    });
  }
}

// Apply class/interface callsite rules from the analysis table.
function identifyTypeCallsites(context, changeSpec, target, entries, seen, changeIndex) {
  const incomingEdges = context.incomingEdgesByTarget.get(target.nodeId) ?? [];
  const scope = changeSpec.scope;

  if (scope === "name") {
    addCallsitesByRelations(context, incomingEdges, ["imports-type"], "import", entries, seen, changeIndex);
    addCallsitesByRelations(context, incomingEdges, ["extends-type", "implements-type"], "class-declaration", entries, seen, changeIndex);
    addCallsitesByRelations(context, incomingEdges, [...TYPE_USAGE_RELATIONS], "variable-usage", entries, seen, changeIndex);
    addCallsitesByRelations(context, incomingEdges, ["instantiates-type", "constructed-type"], "object-creation", entries, seen, changeIndex);
    addExternalTypeCallsites(context, target, ["import", "class-declaration", "variable-usage", "object-creation"], entries, seen, changeIndex);
    addStaticInvokeCallsites(context, target, entries, seen, changeIndex);
    return;
  }

  if (scope === "extends-implements") {
    addCallsitesByRelations(context, incomingEdges, ["extends-type", "implements-type"], "class-declaration", entries, seen, changeIndex);
    addExternalTypeCallsites(context, target, ["class-declaration"], entries, seen, changeIndex);
    return;
  }

}

// Apply method/constructor callsite rules from the analysis table.
function identifyCallableCallsites(context, changeSpec, target, entries, seen, changeIndex) {
  const scope = changeSpec.scope;
  const invokeScopes = new Set(["name", "param-list", "overall"]);
  if (invokeScopes.has(scope)) {
    const incomingEdges = context.incomingEdgesByTarget.get(target.nodeId) ?? [];
    const callRelation = target.kind === "constructor" ? "calls-constructor" : "calls-method";
    addCallsitesByRelations(context, incomingEdges, [callRelation], "invoke", entries, seen, changeIndex);
    addExternalCallableInvocationCallsites(context, target, entries, seen, changeIndex);
  }

  if ((target.kind === "method" || target.kind === "constructor") && !target.external) {
    addCallsite(entries, seen, {
      nodeId: target.nodeId,
      role: "method-declaration",
      reason: `target-${target.kind}-declaration`,
      changeIndex,
    });
  }
}

// Detect static invocations that use the target type name as the receiver.
function addStaticInvokeCallsites(context, target, entries, seen, changeIndex) {
  const targetMethods = context.symbolIndex.methodsByOwner.get(target.qualifiedName) ?? [];
  for (const methodFact of targetMethods) {
    const incomingEdges = context.incomingEdgesByTarget.get(methodFact.nodeId) ?? [];
    for (const edge of incomingEdges) {
      if (edge.kind !== "dep" || edge.relation !== "calls-method") {
        continue;
      }
      const invocationFact = context.methodInvocationByNodeId.get(edge.source);
      if (!invocationFact?.objectText) {
        continue;
      }
      if (invocationFact.objectText === target.simpleName || invocationFact.objectText === target.qualifiedName) {
        addCallsite(entries, seen, {
          nodeId: edge.source,
          role: "static-invoke",
          reason: "type-name-static-invoke",
          changeIndex,
        });
      }
    }
  }
}

// Find type callsites by text/fact matching when the changed type has no source node.
function addExternalTypeCallsites(context, target, roles, entries, seen, changeIndex) {
  if (!target.external) {
    return;
  }

  const roleSet = new Set(roles);
  for (const analyzedFile of context.analyzedFiles) {
    const { facts } = analyzedFile;
    if (roleSet.has("import")) {
      for (const importFact of facts.imports) {
        if (matchesTypeName(importFact.targetName, target, facts)) {
          addCallsite(entries, seen, {
            nodeId: importFact.nodeId,
            role: "import",
            reason: "imports-type",
            changeIndex,
          });
        }
      }
    }

    if (roleSet.has("class-declaration")) {
      for (const typeFact of facts.types) {
        const relatedNames = [...typeFact.superclassNames, ...typeFact.interfaceNames];
        if (relatedNames.some((name) => matchesTypeName(name, target, facts))) {
          addCallsite(entries, seen, {
            nodeId: typeFact.nodeId,
            role: "class-declaration",
            reason: "extends-implements-type",
            changeIndex,
          });
        }
      }
    }

    if (roleSet.has("variable-usage")) {
      for (const typeReference of facts.typeReferences) {
        if (matchesTypeName(typeReference.rawTypeName, target, facts)) {
          addCallsite(entries, seen, {
            nodeId: typeReference.nodeId,
            role: "variable-usage",
            reason: typeReference.context,
            changeIndex,
          });
        }
      }
    }

    if (roleSet.has("object-creation")) {
      for (const objectCreation of facts.objectCreations) {
        if (matchesTypeName(objectCreation.typeName, target, facts)) {
          addCallsite(entries, seen, {
            nodeId: objectCreation.nodeId,
            role: "object-creation",
            reason: "constructed-type",
            changeIndex,
          });
        }
      }
    }
  }
}

// Find invocation callsites for an API signature even when the API declaration is external.
function addExternalCallableInvocationCallsites(context, target, entries, seen, changeIndex) {
  if (!target.external) {
    return;
  }

  if (target.kind === "constructor") {
    for (const analyzedFile of context.analyzedFiles) {
      const fileFacts = analyzedFile.facts;
      for (const objectCreation of fileFacts.objectCreations) {
        if (typeof target.paramCount === "number" && objectCreation.argumentCount !== target.paramCount) {
          continue;
        }
        if (!matchesTypeName(objectCreation.typeName, {
          qualifiedName: target.ownerQualifiedName,
          simpleName: lastNameSegment(target.ownerQualifiedName),
        }, fileFacts)) {
          continue;
        }
        addCallsite(entries, seen, {
          nodeId: objectCreation.nodeId,
          role: "invoke",
          reason: "calls-constructor",
          changeIndex,
        });
      }
    }
    return;
  }

  for (const invocation of context.methodInvocationByNodeId.values()) {
    if (!matchesCallableInvocation(context, invocation, target)) {
      continue;
    }
    addCallsite(entries, seen, {
      nodeId: invocation.nodeId,
      role: "invoke",
      reason: target.kind === "constructor" ? "calls-constructor" : "calls-method",
      changeIndex,
    });
  }
}

// Check invocation name, arity, and receiver type against a target signature.
function matchesCallableInvocation(context, invocation, target) {
  if (target.kind === "method" && invocation.name !== target.name) {
    return false;
  }
  if (typeof target.paramCount === "number" && invocation.argumentCount !== target.paramCount) {
    return false;
  }

  const fileFacts = context.fileFactsByPath.get(invocation.filePath);
  const receiverTypeName = inferInvocationReceiverTypeName(context, invocation);
  if (matchesTypeName(receiverTypeName, {
    qualifiedName: target.ownerQualifiedName,
    simpleName: lastNameSegment(target.ownerQualifiedName),
  }, fileFacts)) {
    return true;
  }
  return Boolean(target.external);
}

// Infer the receiver type name using local bindings, fields, imports, or static receiver text.
function inferInvocationReceiverTypeName(context, invocation) {
  if (!invocation.objectText) {
    return invocation.enclosingTypeQualifiedName;
  }

  const fileFacts = context.fileFactsByPath.get(invocation.filePath);
  const objectText = invocation.objectText.trim();
  if (objectText === "this") {
    return invocation.enclosingTypeQualifiedName;
  }

  const callableFact = context.symbolIndex.callablesByNodeId.get(invocation.enclosingCallableNodeId);
  const localBinding = callableFact?.localBindings
    ?.filter((binding) => binding.name === objectText && binding.declaredAt <= invocation.startIndex)
    .sort((left, right) => right.declaredAt - left.declaredAt)[0];
  if (localBinding?.typeName) {
    return localBinding.typeName;
  }

  const fields = context.symbolIndex.fieldsByOwner.get(invocation.enclosingTypeQualifiedName) ?? [];
  const field = fields.find((candidate) => candidate.name === objectText);
  if (field?.typeName) {
    return field.typeName;
  }

  const importedType = resolveImportedTypeName(fileFacts, objectText);
  return importedType ?? objectText;
}

// Resolve a simple type name through imports in one source file.
function resolveImportedTypeName(fileFacts, rawName) {
  if (!fileFacts || !rawName) {
    return null;
  }

  const simpleName = lastNameSegment(rawName);
  const explicitImport = fileFacts.imports.find((importFact) => lastNameSegment(importFact.targetName) === simpleName);
  if (explicitImport) {
    return explicitImport.targetName;
  }

  return rawName;
}

// Compare a raw type name against a target type using qualified and simple names.
function matchesTypeName(rawName, target, fileFacts) {
  if (!rawName) {
    return false;
  }

  const resolvedName = resolveImportedTypeName(fileFacts, normalizeParameterTypeText(rawName));
  const targetQualifiedName = target.qualifiedName;
  const targetSimpleName = target.simpleName ?? lastNameSegment(targetQualifiedName);
  return resolvedName === targetQualifiedName || lastNameSegment(resolvedName) === targetSimpleName;
}

// Add callsites whose incoming relation to the target matches one of the requested relations.
function addCallsitesByRelations(context, edges, relations, role, entries, seen, changeIndex) {
  const relationSet = new Set(relations);
  for (const edge of edges) {
    if (edge.kind !== "dep" || !relationSet.has(edge.relation)) {
      continue;
    }
    const sourceNode = context.nodeMap.get(edge.source);
    if (!sourceNode || sourceNode.category !== "statement") {
      continue;
    }
    addCallsite(entries, seen, {
      nodeId: edge.source,
      role,
      reason: edge.relation,
      changeIndex,
    });
  }
}

// Insert one deduplicated callsite record.
function addCallsite(entries, seen, callsite) {
  const key = `${callsite.changeIndex ?? 0}::${callsite.nodeId}::${callsite.role}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  entries.push({
    ...callsite,
    key,
  });
}

// Compute impacted nodes for one callsite according to granularity and scope.
function getImpactNodes(context, changeSpec, target, callsite) {
  const impacts = new Map();
  const scope = changeSpec.scope;

  if (target.kind === "type") {
    getTypeImpactNodes(context, scope, target, callsite, impacts);
  } else if (target.kind === "variable") {
    getVariableImpactNodes(context, scope, target, callsite, impacts);
  } else {
    getCallableImpactNodes(context, scope, target, callsite, impacts);
  }

  return [...impacts.values()].sort((left, right) => {
    const leftNode = context.nodeMap.get(left.nodeId);
    const rightNode = context.nodeMap.get(right.nodeId);
    return (leftNode?.order ?? 0) - (rightNode?.order ?? 0);
  });
}

// Compute Before/After Callsite nodes for a constant or variable change.
function getVariableImpactNodes(context, scope, target, callsite, impacts) {
  if (scope === "name") {
    for (const importNodeId of collectImportNodesForVariableInFile(context, target, context.nodeMap.get(callsite.nodeId)?.filePath)) {
      addImpact(impacts, importNodeId, "redep", "import-preparation");
    }
    return;
  }

  if (scope === "data-type" || scope === "datatype" || scope === "value") {
    for (const afterNodeId of collectLaterVariableUsageStatements(context, target, callsite.nodeId)) {
      addImpact(impacts, afterNodeId, "dep", "variable-usage-follow-up");
    }
  }
}

// Compute impacted nodes for a class/interface change.
function getTypeImpactNodes(context, scope, target, callsite, impacts) {
  if (scope === "name" && callsite.role === "variable-usage") {
    for (const importNodeId of collectImportNodesForTypeInFile(context, target, context.nodeMap.get(callsite.nodeId)?.filePath)) {
      addImpact(impacts, importNodeId, "redep", "import-preparation");
    }
  }

}

// Compute impacted nodes for a method/constructor change.
function getCallableImpactNodes(context, scope, target, callsite, impacts) {
  const methodLikeScopes = new Set(["param-list", "return-type", "return-value", "overall"]);

  if (!methodLikeScopes.has(scope)) {
    return;
  }

  if ((scope === "param-list" || scope === "overall") && callsite.role === "invoke") {
    for (const beforeNodeId of collectBackwardPreparationStatements(context, callsite.nodeId)) {
      addImpact(impacts, beforeNodeId, "redep", "parameter-preparation");
    }
  }

  if ((scope === "param-list" || scope === "overall") && callsite.role === "method-declaration") {
    for (const parameterNodeId of collectFormalParameterNodes(context, callsite.nodeId)) {
      addImpact(impacts, parameterNodeId, "redep", "parameter-declaration");
    }
  }

  if ((scope === "return-type" || scope === "return-value" || scope === "overall") && callsite.role === "invoke") {
    for (const afterNodeId of collectAfterCallsiteReturnUsage(context, callsite.nodeId)) {
      addImpact(impacts, afterNodeId, "dep", "return-value-usage");
    }
  }

  if ((scope === "return-type" || scope === "return-value" || scope === "overall") && callsite.role === "method-declaration") {
    for (const invocationNodeId of collectInvocationNodesForCallable(context, target)) {
      for (const afterNodeId of collectAfterCallsiteReturnUsage(context, invocationNodeId)) {
        addImpact(impacts, afterNodeId, "dep", "return-value-usage");
      }
    }
  }
}

// Collect import statements in one file that reference the target type.
function collectImportNodesForTypeInFile(context, target, filePath) {
  if (target.external) {
    const fileFacts = context.fileFactsByPath.get(filePath);
    return fileFacts?.imports
      ?.filter((importFact) => matchesTypeName(importFact.targetName, target, fileFacts))
      .map((importFact) => importFact.nodeId) ?? [];
  }

  const incomingEdges = context.incomingEdgesByTarget.get(target.nodeId) ?? [];
  return incomingEdges
    .filter((edge) => edge.kind === "dep" && edge.relation === "imports-type")
    .map((edge) => edge.source)
    .filter((nodeId) => context.nodeMap.get(nodeId)?.filePath === filePath);
}

// Collect imports for a variable's declared type in the same source file.
function collectImportNodesForVariableInFile(context, target, filePath) {
  if (!target.typeName) {
    return [];
  }

  const fileFacts = context.fileFactsByPath.get(filePath);
  return fileFacts?.imports
    ?.filter((importFact) => lastNameSegment(importFact.targetName) === lastNameSegment(target.typeName))
    .map((importFact) => importFact.nodeId) ?? [];
}

// Find declaration and use statements whose identifier elements refer to the target variable scope.
function collectVariableUsageStatements(context, target) {
  const rawNodeIds = new Set([target.nodeId]);
  for (const statementNode of context.statementNodes) {
    if (statementNode.filePath !== target.filePath || !isStatementInVariableScope(context, statementNode.id, target)) {
      continue;
    }

    const usedElements = context.outgoingEdgesBySource.get(statementNode.id) ?? [];
    if (usedElements.some((edge) => edge.kind === "redep" && context.nodeMap.get(edge.target)?.type === "identifier" && context.nodeMap.get(edge.target)?.text === target.name)) {
      rawNodeIds.add(statementNode.id);
    }
  }

  const nodeIds = new Set();
  for (const nodeId of rawNodeIds) {
    const hasMoreSpecificUsage = [...rawNodeIds].some((otherNodeId) => otherNodeId !== nodeId && isDescendantOfNode(context, otherNodeId, nodeId));
    if (!hasMoreSpecificUsage) {
      nodeIds.add(normalizeImpactStatementNodeId(context, nodeId) ?? nodeId);
    }
  }

  return [...nodeIds].sort((left, right) => (context.nodeMap.get(left)?.order ?? 0) - (context.nodeMap.get(right)?.order ?? 0));
}

// Keep local and parameter uses inside their declaring callable, and field uses inside their owner type.
function isStatementInVariableScope(context, statementNodeId, target) {
  if (target.variableKind === "field") {
    const ownerTypeNodeId = context.symbolIndex.typeByQualifiedName.get(target.ownerQualifiedName)?.nodeId;
    return ownerTypeNodeId ? isDescendantOfNode(context, statementNodeId, ownerTypeNodeId) : false;
  }

  return findEnclosingCallableNodeId(context, statementNodeId) === target.enclosingCallableNodeId;
}

// Return statement-level variable uses that occur after the selected callsite.
function collectLaterVariableUsageStatements(context, target, callsiteNodeId) {
  const callsiteOrder = context.nodeMap.get(callsiteNodeId)?.order ?? -1;
  return collectVariableUsageStatements(context, target)
    .filter((nodeId) => nodeId !== callsiteNodeId && (context.nodeMap.get(nodeId)?.order ?? -1) > callsiteOrder);
}

// Walk backward over local data-flow edges to find parameter preparation statements.
function collectBackwardPreparationStatements(context, nodeId) {
  return traverseStatementDataFlow(context, [nodeId, findContainingStatementNodeId(context, nodeId)], "backward");
}

// Walk forward from a return carrier to find statements that use the call result.
function collectAfterCallsiteReturnUsage(context, invocationNodeId) {
  const carrierNodeId = resolveReturnCarrierStatementNodeId(context, invocationNodeId);
  if (!carrierNodeId) {
    return [];
  }

  return traverseStatementDataFlow(context, [carrierNodeId], "forward");
}

// Traverse local statement-level data flow in either forward or backward direction.
function traverseStatementDataFlow(context, seeds, direction) {
  const results = new Set();
  const visited = new Set();
  const pending = seeds.filter(Boolean);

  while (pending.length > 0) {
    const currentNodeId = pending.pop();
    if (!currentNodeId || visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);

    const edges = direction === "forward"
      ? context.outgoingEdgesBySource.get(currentNodeId) ?? []
      : context.incomingEdgesByTarget.get(currentNodeId) ?? [];

    for (const edge of edges) {
      if (edge.kind !== "dep" || edge.relation !== "data-flow") {
        continue;
      }

      const neighborNodeId = direction === "forward" ? edge.target : edge.source;
      const neighborNode = context.nodeMap.get(neighborNodeId);
      if (!neighborNode || neighborNode.category !== "statement") {
        continue;
      }

      const normalizedNodeId = normalizeImpactStatementNodeId(context, neighborNodeId);
      if (normalizedNodeId && !visited.has(normalizedNodeId)) {
        results.add(normalizedNodeId);
      }
      if (!visited.has(neighborNodeId)) {
        pending.push(neighborNodeId);
      }
    }
  }

  return [...results];
}

// Collect formal parameter nodes that belong directly to a method declaration.
function collectFormalParameterNodes(context, methodDeclarationNodeId) {
  const outgoingEdges = context.outgoingEdgesBySource.get(methodDeclarationNodeId) ?? [];
  return outgoingEdges
    .filter((edge) => edge.kind === "str" && edge.relation === "hierarchy")
    .map((edge) => edge.target)
    .filter((nodeId) => context.nodeMap.get(nodeId)?.type === "formal_parameter");
}

// Find the statement node that stores the return value produced by an invocation.
function resolveReturnCarrierStatementNodeId(context, invocationNodeId) {
  const parentStatementNodeId = findContainingStatementNodeId(context, invocationNodeId);
  if (!parentStatementNodeId) {
    return null;
  }

  const parentStatementNode = context.nodeMap.get(parentStatementNodeId);
  return STATEMENT_TYPES_WITH_RETURN_CARRIER.has(parentStatementNode?.type)
    ? parentStatementNodeId
    : null;
}

// Collapse expression-level impacts back to their containing statement when needed.
function normalizeImpactStatementNodeId(context, nodeId) {
  const node = context.nodeMap.get(nodeId);
  if (!node) {
    return null;
  }

  if (node.type === "method_invocation" || node.type === "object_creation_expression" || node.type === "binary_expression") {
    return findContainingStatementNodeId(context, nodeId) ?? nodeId;
  }

  return nodeId;
}

// Climb hierarchy edges until the nearest enclosing statement node is found.
function findContainingStatementNodeId(context, nodeId) {
  const incomingEdges = context.incomingEdgesByTarget.get(nodeId) ?? [];
  const hierarchyParentEdge = incomingEdges.find((edge) => edge.kind === "str" && edge.relation === "hierarchy");
  if (!hierarchyParentEdge) {
    return null;
  }

  const parentNode = context.nodeMap.get(hierarchyParentEdge.source);
  if (!parentNode) {
    return null;
  }

  if (parentNode.category === "statement") {
    return parentNode.id;
  }

  return findContainingStatementNodeId(context, parentNode.id);
}

// Locate the nearest enclosing method or constructor declaration for a graph node.
function findEnclosingCallableNodeId(context, nodeId) {
  const incomingEdges = context.incomingEdgesByTarget.get(nodeId) ?? [];
  const hierarchyParentEdge = incomingEdges.find((edge) => edge.kind === "str" && edge.relation === "hierarchy");
  if (!hierarchyParentEdge) {
    return null;
  }

  const parentNode = context.nodeMap.get(hierarchyParentEdge.source);
  if (!parentNode) {
    return null;
  }
  if (parentNode.type === "method_declaration" || parentNode.type === "constructor_declaration") {
    return parentNode.id;
  }

  return findEnclosingCallableNodeId(context, parentNode.id);
}

// Test whether a graph node is nested below a specified owner node through hierarchy edges.
function isDescendantOfNode(context, nodeId, ancestorNodeId) {
  if (nodeId === ancestorNodeId) {
    return true;
  }
  const incomingEdges = context.incomingEdgesByTarget.get(nodeId) ?? [];
  const hierarchyParentEdge = incomingEdges.find((edge) => edge.kind === "str" && edge.relation === "hierarchy");
  return hierarchyParentEdge ? isDescendantOfNode(context, hierarchyParentEdge.source, ancestorNodeId) : false;
}

// Collect all invocation nodes that dispatch to the chosen callable target.
function collectInvocationNodesForCallable(context, target) {
  if (target.external) {
    return [...context.methodInvocationByNodeId.values()]
      .filter((invocation) => matchesCallableInvocation(context, invocation, target))
      .map((invocation) => invocation.nodeId);
  }

  const relation = target.kind === "constructor" ? "calls-constructor" : "calls-method";
  const incomingEdges = context.incomingEdgesByTarget.get(target.nodeId) ?? [];
  return incomingEdges
    .filter((edge) => edge.kind === "dep" && edge.relation === relation)
    .map((edge) => edge.source);
}

// Add one impacted node and keep the stronger redep marker when both exist.
function addImpact(impacts, nodeId, edgeType, reason) {
  if (!impacts.has(nodeId)) {
    impacts.set(nodeId, {
      nodeId,
      edgeType,
      reason,
    });
    return;
  }

  if (edgeType === "redep") {
    impacts.get(nodeId).edgeType = "redep";
  }
}

// Execute the chain exploration algorithm over statement nodes and callsite impacts.
function exploreChangeChains(context, callsites, callsiteImpactMap, changeSpec, target) {
  const remainingNodeIds = new Set(context.statementNodes.map((node) => node.id));
  const activeCallsiteKeys = new Set(callsites.map((callsite) => callsite.key));
  const indegree = new Map();

  for (const statementNode of context.statementNodes) {
    indegree.set(statementNode.id, countStatementInDegree(context, statementNode.id));
  }

  const blocks = [];
  while (remainingNodeIds.size > 0 && activeCallsiteKeys.size > 0) {
    const currentNodeId = selectNodeWithMinimumInDegree(context, remainingNodeIds, indegree);
    const matchingCallsites = callsites.filter((callsite) => callsite.nodeId === currentNodeId && activeCallsiteKeys.has(callsite.key));

    for (const callsite of matchingCallsites) {
      const impacts = callsiteImpactMap.get(callsite.key) ?? [];
      const before = [];
      const after = [];

      for (const impact of impacts) {
        if (impact.edgeType === "redep") {
          before.push(attachNode(context, impact.nodeId, impact.reason));
        } else {
          after.push(attachNode(context, impact.nodeId, impact.reason));
        }
        indegree.set(impact.nodeId, Math.max(0, (indegree.get(impact.nodeId) ?? 0) - 1));
      }

      blocks.push({
        changeIndex: callsite.changeIndex ?? 0,
        granularity: callsite.granularity ?? changeSpec?.granularity,
        scope: callsite.scope ?? changeSpec?.scope,
        role: callsite.role,
        reason: callsite.reason,
        callsite: attachNode(context, callsite.nodeId, callsite.reason),
        beforeCallsite: before,
        afterCallsite: after,
        target: summarizeTarget(callsite.target ?? target),
      });
      activeCallsiteKeys.delete(callsite.key);
    }

    remainingNodeIds.delete(currentNodeId);
  }

  return blocks;
}

// Count statement-to-statement dependency edges for CEA in-degree ordering.
function countStatementInDegree(context, nodeId) {
  const incomingEdges = context.incomingEdgesByTarget.get(nodeId) ?? [];
  return incomingEdges.filter((edge) => {
    if (edge.kind !== "dep") {
      return false;
    }
    const sourceNode = context.nodeMap.get(edge.source);
    const targetNode = context.nodeMap.get(edge.target);
    return sourceNode?.category === "statement" && targetNode?.category === "statement";
  }).length;
}

// Select the remaining statement node with minimum in-degree, breaking ties by order.
function selectNodeWithMinimumInDegree(context, remainingNodeIds, indegree) {
  let winner = null;

  for (const nodeId of remainingNodeIds) {
    if (!winner) {
      winner = nodeId;
      continue;
    }

    const currentInDegree = indegree.get(nodeId) ?? 0;
    const winnerInDegree = indegree.get(winner) ?? 0;
    if (currentInDegree < winnerInDegree) {
      winner = nodeId;
      continue;
    }

    if (currentInDegree === winnerInDegree) {
      const currentOrder = context.nodeMap.get(nodeId)?.order ?? 0;
      const winnerOrder = context.nodeMap.get(winner)?.order ?? 0;
      if (currentOrder < winnerOrder) {
        winner = nodeId;
      }
    }
  }

  return winner;
}

// Attach readable node metadata to a compact result record.
function attachNode(context, nodeId, reason) {
  const node = context.nodeMap.get(nodeId);
  return {
    nodeId,
    type: node?.type ?? null,
    text: node?.text ?? null,
    filePath: node?.filePath ?? null,
    reason,
  };
}

// Convert a raw callsite record into stable output fields.
function summarizeCallsite(context, callsite) {
  const node = context.nodeMap.get(callsite.nodeId);
  return {
    changeIndex: callsite.changeIndex ?? 0,
    nodeId: callsite.nodeId,
    role: callsite.role,
    reason: callsite.reason,
    granularity: callsite.granularity ?? null,
    scope: callsite.scope ?? null,
    target: callsite.target ? summarizeTarget(callsite.target) : null,
    type: node?.type ?? null,
    text: node?.text ?? null,
    filePath: node?.filePath ?? null,
  };
}

// Convert the resolved target fact into the public result shape.
function summarizeTarget(target) {
  if (target.kind === "type") {
    return {
      kind: "type",
      nodeId: target.nodeId,
      qualifiedName: target.qualifiedName,
      simpleName: target.simpleName,
      filePath: target.filePath,
    };
  }

  if (target.kind === "variable") {
    return {
      kind: target.isConstant ? "constant" : "variable",
      nodeId: target.nodeId,
      name: target.name,
      variableKind: target.variableKind,
      typeName: target.typeName,
      ownerQualifiedName: target.ownerQualifiedName,
      enclosingCallableNodeId: target.enclosingCallableNodeId,
      filePath: target.filePath,
    };
  }

  return {
    kind: target.kind,
    nodeId: target.nodeId,
    ownerQualifiedName: target.ownerQualifiedName,
    name: target.name ?? null,
    paramCount: target.paramCount,
    filePath: target.filePath,
  };
}

// Normalize a parameter type string from a full API signature.
function normalizeParameterTypeText(rawTypeName) {
  return String(rawTypeName ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\[\]$/g, "")
    .replace(/\.\.\.$/g, "")
    .replace(/<.*>/g, "");
}

// Split a separator-delimited list while ignoring separators inside generic arguments.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";

  for (const char of text) {
    if (char === "<") {
      depth += 1;
    } else if (char === ">") {
      depth = Math.max(0, depth - 1);
    }

    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

// Return the final segment of a qualified Java name.
function lastNameSegment(name) {
  return String(name ?? "").split(".").at(-1);
}

// Append one value to a list-valued map entry.
function appendToList(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}
