import { normalizeTypeName } from "./graph-builder.js";

// Add cross-file semantic dependency edges after all files have been parsed.
export function linkProjectSemanticEdges(analyzedFiles) {
  const index = buildSymbolIndex(analyzedFiles);
  const edges = [];
  const edgeIds = new Set();

  for (const analyzedFile of analyzedFiles) {
    const fileFacts = analyzedFile.facts;

    for (const importFact of fileFacts.imports) {
      if (importFact.isStatic) {
        continue;
      }
      const targetType = resolveTypeName(importFact.targetName, fileFacts, index);
      if (targetType) {
        addEdge(edges, edgeIds, "dep", importFact.nodeId, targetType.nodeId, "imports-type");
      }
    }

    for (const typeFact of fileFacts.types) {
      for (const superclassName of typeFact.superclassNames) {
        const targetType = resolveTypeName(superclassName, fileFacts, index);
        if (targetType) {
          addEdge(edges, edgeIds, "dep", typeFact.nodeId, targetType.nodeId, "extends-type");
        }
      }
      for (const interfaceName of typeFact.interfaceNames) {
        const targetType = resolveTypeName(interfaceName, fileFacts, index);
        if (targetType) {
          addEdge(edges, edgeIds, "dep", typeFact.nodeId, targetType.nodeId, "implements-type");
        }
      }
    }

    for (const typeReference of fileFacts.typeReferences) {
      const targetType = resolveTypeName(typeReference.rawTypeName, fileFacts, index);
      if (targetType) {
        addEdge(edges, edgeIds, "dep", typeReference.nodeId, targetType.nodeId, typeReference.context);
      }
    }

    for (const objectCreation of fileFacts.objectCreations) {
      const targetType = resolveTypeName(objectCreation.typeName, fileFacts, index);
      if (!targetType) {
        continue;
      }

      addEdge(edges, edgeIds, "dep", objectCreation.nodeId, targetType.nodeId, "instantiates-type");
      const targetConstructor = resolveConstructor(targetType, objectCreation.argumentCount, index);
      if (targetConstructor) {
        addEdge(edges, edgeIds, "dep", objectCreation.nodeId, targetConstructor.nodeId, "calls-constructor");
      }
    }

    for (const invocation of fileFacts.methodInvocations) {
      const targetMethod = resolveMethodInvocation(invocation, fileFacts, index);
      if (targetMethod) {
        addEdge(edges, edgeIds, "dep", invocation.nodeId, targetMethod.nodeId, "calls-method");
      }
    }
  }

  return edges;
}

// Index discovered types, methods, constructors, and fields for later resolution.
export function buildSymbolIndex(analyzedFiles) {
  const fileFactsByPath = new Map();
  const typeByQualifiedName = new Map();
  const typesBySimpleName = new Map();
  const methodsByOwner = new Map();
  const constructorsByOwner = new Map();
  const fieldsByOwner = new Map();
  const variablesByName = new Map();
  const variablesByNodeId = new Map();
  const callablesByNodeId = new Map();

  for (const analyzedFile of analyzedFiles) {
    const fileFacts = analyzedFile.facts;
    fileFactsByPath.set(fileFacts.filePath, fileFacts);

    for (const typeFact of fileFacts.types) {
      typeByQualifiedName.set(typeFact.qualifiedName, typeFact);
      appendToList(typesBySimpleName, typeFact.simpleName, typeFact);
    }

    for (const methodFact of fileFacts.methods) {
      appendToList(methodsByOwner, methodFact.ownerQualifiedName, methodFact);
      callablesByNodeId.set(methodFact.nodeId, methodFact);
    }

    for (const constructorFact of fileFacts.constructors) {
      appendToList(constructorsByOwner, constructorFact.ownerQualifiedName, constructorFact);
      callablesByNodeId.set(constructorFact.nodeId, constructorFact);
    }

    for (const fieldFact of fileFacts.fields) {
      appendToList(fieldsByOwner, fieldFact.ownerQualifiedName, fieldFact);
    }

    for (const variableFact of fileFacts.variables ?? []) {
      appendToList(variablesByName, variableFact.name, variableFact);
      appendToList(variablesByNodeId, variableFact.nodeId, variableFact);
    }
  }

  return {
    fileFactsByPath,
    typeByQualifiedName,
    typesBySimpleName,
    methodsByOwner,
    constructorsByOwner,
    fieldsByOwner,
    variablesByName,
    variablesByNodeId,
    callablesByNodeId,
  };
}

// Resolve one invocation fact to the method declaration it likely targets.
function resolveMethodInvocation(invocation, fileFacts, index) {
  const receiverType = resolveReceiverType(invocation, fileFacts, index);
  if (!receiverType) {
    return null;
  }

  return resolveMethodOnTypeHierarchy(receiverType, invocation.name, invocation.argumentCount, index);
}

// Infer the receiver type for an invocation from locals, fields, or explicit type names.
function resolveReceiverType(invocation, fileFacts, index) {
  if (!invocation.enclosingTypeQualifiedName) {
    return null;
  }

  const currentType = index.typeByQualifiedName.get(invocation.enclosingTypeQualifiedName);
  if (!currentType) {
    return null;
  }

  if (!invocation.objectText) {
    return currentType;
  }

  const objectText = invocation.objectText.trim();
  if (!objectText) {
    return currentType;
  }
  if (objectText === "this") {
    return currentType;
  }
  if (objectText === "super") {
    return resolveFirstSuperType(currentType, index);
  }

  const callableFact = index.callablesByNodeId.get(invocation.enclosingCallableNodeId);
  const localBindingType = resolveLocalBindingType(callableFact, objectText, invocation.startIndex, fileFacts, index);
  if (localBindingType) {
    return localBindingType;
  }

  const fieldType = resolveFieldType(currentType, objectText, fileFacts, index);
  if (fieldType) {
    return fieldType;
  }

  const exactType = resolveTypeName(objectText, fileFacts, index);
  if (exactType) {
    return exactType;
  }

  if (objectText.includes(".")) {
    const rootObject = objectText.split(".")[0];
    const rootedLocalType = resolveLocalBindingType(callableFact, rootObject, invocation.startIndex, fileFacts, index);
    if (rootedLocalType) {
      return rootedLocalType;
    }
    return resolveFieldType(currentType, rootObject, fileFacts, index);
  }

  return null;
}

// Look up the most recent visible local binding and resolve its declared type.
function resolveLocalBindingType(callableFact, variableName, referenceIndex, fileFacts, index) {
  if (!callableFact?.localBindings) {
    return null;
  }

  const candidates = callableFact.localBindings
    .filter((binding) => binding.name === variableName && binding.declaredAt <= referenceIndex)
    .sort((left, right) => right.declaredAt - left.declaredAt);

  if (candidates.length === 0) {
    return null;
  }

  return resolveTypeName(candidates[0].typeName, fileFacts, index);
}

// Resolve the declared type of a field access receiver.
function resolveFieldType(typeFact, fieldName, fileFacts, index) {
  const field = resolveFieldOnTypeHierarchy(typeFact, fieldName, index);
  if (!field?.typeName) {
    return null;
  }

  return resolveTypeName(field.typeName, fileFacts, index);
}

// Search a type and its ancestors for a matching field declaration.
function resolveFieldOnTypeHierarchy(typeFact, fieldName, index) {
  const visited = new Set();
  const pending = [typeFact];

  while (pending.length > 0) {
    const currentType = pending.shift();
    if (!currentType || visited.has(currentType.qualifiedName)) {
      continue;
    }
    visited.add(currentType.qualifiedName);

    const fields = index.fieldsByOwner.get(currentType.qualifiedName) ?? [];
    const exactField = fields.find((field) => field.name === fieldName);
    if (exactField) {
      return exactField;
    }

    for (const superType of resolveSuperTypes(currentType, index)) {
      pending.push(superType);
    }
  }

  return null;
}

// Search a type hierarchy for the best method match by name and arity.
function resolveMethodOnTypeHierarchy(typeFact, methodName, argumentCount, index) {
  const visited = new Set();
  const pending = [typeFact];

  while (pending.length > 0) {
    const currentType = pending.shift();
    if (!currentType || visited.has(currentType.qualifiedName)) {
      continue;
    }
    visited.add(currentType.qualifiedName);

    const methods = index.methodsByOwner.get(currentType.qualifiedName) ?? [];
    const exactMatch = methods.find((method) => method.name === methodName && method.paramCount === argumentCount);
    if (exactMatch) {
      return exactMatch;
    }

    const nameOnlyMatch = methods.find((method) => method.name === methodName);
    if (nameOnlyMatch) {
      return nameOnlyMatch;
    }

    for (const superType of resolveSuperTypes(currentType, index)) {
      pending.push(superType);
    }
  }

  return null;
}

// Resolve an object creation to the best constructor declaration.
function resolveConstructor(typeFact, argumentCount, index) {
  const constructors = index.constructorsByOwner.get(typeFact.qualifiedName) ?? [];
  return constructors.find((constructorFact) => constructorFact.paramCount === argumentCount) ?? constructors[0] ?? null;
}

// Resolve declared superclass and interface names to concrete type facts.
function resolveSuperTypes(typeFact, index) {
  const fileFacts = index.fileFactsByPath.get(typeFact.filePath);
  if (!fileFacts) {
    return [];
  }

  const resolved = [];
  for (const rawTypeName of [...typeFact.superclassNames, ...typeFact.interfaceNames]) {
    const targetType = resolveTypeName(rawTypeName, fileFacts, index);
    if (targetType) {
      resolved.push(targetType);
    }
  }
  return resolved;
}

// Return the first available super type for explicit super dispatch.
function resolveFirstSuperType(typeFact, index) {
  return resolveSuperTypes(typeFact, index)[0] ?? null;
}

// Resolve a raw type name using qualified names, imports, and package scope.
function resolveTypeName(rawTypeName, fileFacts, index) {
  const normalizedName = normalizeTypeName(rawTypeName);
  if (!normalizedName) {
    return null;
  }

  if (index.typeByQualifiedName.has(normalizedName)) {
    return index.typeByQualifiedName.get(normalizedName);
  }

  if (normalizedName.includes(".")) {
    const maybeQualified = tryResolveQualifiedTail(normalizedName, index);
    if (maybeQualified) {
      return maybeQualified;
    }
  }

  const explicitImportMatch = findExplicitImportMatch(normalizedName, fileFacts, index);
  if (explicitImportMatch) {
    return explicitImportMatch;
  }

  const wildcardImportMatch = findWildcardImportMatch(normalizedName, fileFacts, index);
  if (wildcardImportMatch) {
    return wildcardImportMatch;
  }

  if (fileFacts.packageName) {
    const samePackageQualifiedName = `${fileFacts.packageName}.${normalizedName}`;
    if (index.typeByQualifiedName.has(samePackageQualifiedName)) {
      return index.typeByQualifiedName.get(samePackageQualifiedName);
    }
  }

  const simpleNameMatches = index.typesBySimpleName.get(lastNameSegment(normalizedName)) ?? [];
  if (simpleNameMatches.length === 1) {
    return simpleNameMatches[0];
  }

  return null;
}

// Resolve a partially qualified name by matching the tail of known types.
function tryResolveQualifiedTail(normalizedName, index) {
  if (index.typeByQualifiedName.has(normalizedName)) {
    return index.typeByQualifiedName.get(normalizedName);
  }

  const suffix = `.${normalizedName}`;
  const matches = [];
  for (const [qualifiedName, typeFact] of index.typeByQualifiedName.entries()) {
    if (qualifiedName.endsWith(suffix)) {
      matches.push(typeFact);
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

// Match an imported simple name to a concrete project type.
function findExplicitImportMatch(normalizedName, fileFacts, index) {
  for (const importFact of fileFacts.imports) {
    if (importFact.isWildcard || importFact.isStatic) {
      continue;
    }
    if (lastNameSegment(importFact.targetName) !== lastNameSegment(normalizedName)) {
      continue;
    }
    const importedType = index.typeByQualifiedName.get(importFact.targetName);
    if (importedType) {
      return importedType;
    }
  }

  return null;
}

// Match a wildcard import to a concrete project type.
function findWildcardImportMatch(normalizedName, fileFacts, index) {
  const simpleName = lastNameSegment(normalizedName);
  for (const importFact of fileFacts.imports) {
    if (!importFact.isWildcard || importFact.isStatic) {
      continue;
    }

    const packageName = importFact.targetName;
    const qualifiedName = `${packageName}.${simpleName}`;
    if (index.typeByQualifiedName.has(qualifiedName)) {
      return index.typeByQualifiedName.get(qualifiedName);
    }
  }

  return null;
}

// Extract the rightmost segment of a dotted name.
function lastNameSegment(name) {
  return name.split(".").at(-1);
}

// Append one value to a list-valued map entry.
function appendToList(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

// Add one deduplicated semantic edge to the project graph.
function addEdge(edges, edgeIds, kind, source, target, relation) {
  const id = `${kind}:${source}->${target}:${relation}:project`;
  if (edgeIds.has(id)) {
    return;
  }

  edgeIds.add(id);
  edges.push({
    id,
    kind,
    source,
    target,
    relation,
    container: "project",
  });
}
