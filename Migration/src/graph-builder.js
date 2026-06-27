import Parser from "tree-sitter";
import Java from "tree-sitter-java";

const STRUCTURE_NODE_TYPES = new Set([
  "program",
  "class_body",
  "interface_body",
  "enum_body",
  "annotation_type_body",
  "record_body",
  "block",
  "constructor_body",
]);

const STATEMENT_NODE_TYPES = new Set([
  "package_declaration",
  "import_declaration",
  "field_declaration",
  "constant_declaration",
  "local_variable_declaration",
  "formal_parameter",
  "spread_parameter",
  "receiver_parameter",
  "catch_formal_parameter",
  "type_parameter",
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "annotation_type_declaration",
  "record_declaration",
  "constructor_declaration",
  "method_declaration",
  "compact_constructor_declaration",
  "explicit_constructor_invocation",
  "if_statement",
  "for_statement",
  "enhanced_for_statement",
  "while_statement",
  "do_statement",
  "switch_expression",
  "switch_statement",
  "switch_block_statement_group",
  "try_statement",
  "try_with_resources_statement",
  "catch_clause",
  "finally_clause",
  "synchronized_statement",
  "throw_statement",
  "return_statement",
  "break_statement",
  "continue_statement",
  "yield_statement",
  "assert_statement",
  "labeled_statement",
  "expression_statement",
  "assignment_expression",
  "update_expression",
  "binary_expression",
  "ternary_expression",
  "lambda_expression",
  "method_invocation",
  "object_creation_expression",
  "cast_expression",
  "parenthesized_expression",
]);

const ELEMENT_NODE_TYPES = new Set([
  "identifier",
  "type_identifier",
  "scoped_identifier",
  "field_access",
  "array_access",
  "string_literal",
  "character_literal",
  "decimal_integer_literal",
  "hex_integer_literal",
  "octal_integer_literal",
  "binary_integer_literal",
  "decimal_floating_point_literal",
  "hex_floating_point_literal",
  "true",
  "false",
  "null_literal",
  "this",
  "super",
]);

const FLOW_CONTAINER_TYPES = new Set([
  "program",
  "class_body",
  "interface_body",
  "enum_body",
  "annotation_type_body",
  "record_body",
  "constructor_declaration",
  "method_declaration",
  "constructor_body",
  "block",
  "switch_block_statement_group",
]);

const DEFINING_PARENT_TYPES = new Set([
  "variable_declarator",
  "formal_parameter",
  "spread_parameter",
  "receiver_parameter",
  "catch_formal_parameter",
  "assignment_expression",
  "method_declaration",
  "constructor_declaration",
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
]);

const TYPE_DECLARATION_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "annotation_type_declaration",
  "record_declaration",
]);

const parser = new Parser();
parser.setLanguage(Java);

// Build only the heterogeneous graph for one Java source string.
export function buildJavaProjectGraph(sourceCode, options = {}) {
  return analyzeJavaSource(sourceCode, options).graph;
}

// Parse one Java source string and return both graph nodes and semantic facts.
export function analyzeJavaSource(sourceCode, options = {}) {
  const tree = parser.parse(sourceCode);
  const graphBuilder = new GraphBuilder(sourceCode, options);
  graphBuilder.visit(tree.rootNode, null);
  graphBuilder.linkExecutionDependencies();

  const semanticCollector = new SemanticCollector(sourceCode, options);
  semanticCollector.collect(tree.rootNode);

  return {
    graph: graphBuilder.toJSON(),
    facts: semanticCollector.toJSON(),
  };
}

class GraphBuilder {
  // Initialize graph-building state for one parsed Java file.
  constructor(sourceCode, options) {
    this.sourceCode = sourceCode;
    this.filePath = options.filePath ?? null;
    this.fileKey = options.filePath ?? "__memory__";
    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();
    this.edgeIdSet = new Set();
    this.statementOrderByContainer = new Map();
    this.scopeStack = [];
    this.sequence = 0;
    this.rootGraphNodeId = null;
  }

  // Materialize the current graph state into the public JSON shape.
  toJSON() {
    return {
      meta: {
        language: "java",
        filePath: this.filePath,
        rootNodeId: this.rootGraphNodeId,
        nodeCount: this.nodes.length,
        edgeCount: this.edges.length,
      },
      nodes: this.nodes,
      edges: this.edges,
    };
  }

  // Visit one AST node, classify it, create the graph node, and recurse.
  visit(node, parentGraphNodeId) {
    const category = this.resolveCategory(node);
    const graphNodeId = category ? this.ensureNode(node, category) : null;
    const nextParentId = graphNodeId ?? parentGraphNodeId;

    if (!this.rootGraphNodeId && graphNodeId) {
      this.rootGraphNodeId = graphNodeId;
    }

    if (graphNodeId && parentGraphNodeId) {
      this.addEdge("str", parentGraphNodeId, graphNodeId, {
        relation: "hierarchy",
      });
    }

    if (graphNodeId && category === "statement") {
      this.registerStatementSequence(node, graphNodeId);
      this.connectReverseDependencies(node, graphNodeId);
    }

    const pushedScope = this.pushScopeIfNeeded(node, graphNodeId, category);
    for (const child of node.namedChildren) {
      this.visit(child, nextParentId);
    }
    if (pushedScope) {
      this.scopeStack.pop();
    }
  }

  // Map a Tree-sitter node to structure, statement, or element.
  resolveCategory(node) {
    if (ELEMENT_NODE_TYPES.has(node.type) || this.isElementNode(node)) {
      return "element";
    }
    if (STATEMENT_NODE_TYPES.has(node.type) || this.isStatementNode(node)) {
      return "statement";
    }
    if (STRUCTURE_NODE_TYPES.has(node.type) || this.isStructureNode(node)) {
      return "structure";
    }
    return null;
  }

  // Treat *_body nodes as structural containers in the graph.
  isStructureNode(node) {
    return node.type.endsWith("_body");
  }

  // Treat declaration and statement nodes as statement-layer graph nodes.
  isStatementNode(node) {
    return node.type.endsWith("_statement") || node.type.endsWith("_declaration");
  }

  // Treat leaf identifiers and literals as element-layer graph nodes.
  isElementNode(node) {
    if (node.childCount !== 0) {
      return false;
    }

    return node.type === "identifier" || node.type.endsWith("_literal");
  }

  // Create one graph node if it has not been seen before.
  ensureNode(node, category) {
    const nodeId = makeNodeId(node, this.fileKey);
    if (this.nodeMap.has(nodeId)) {
      return nodeId;
    }

    const graphNode = {
      id: nodeId,
      category,
      type: node.type,
      filePath: this.filePath,
      text: sliceNodeText(this.sourceCode, node),
      range: {
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        startPosition: node.startPosition,
        endPosition: node.endPosition,
      },
      order: this.sequence++,
    };

    this.nodeMap.set(nodeId, graphNode);
    this.nodes.push(graphNode);
    return nodeId;
  }

  // Push a scope frame when the current node can contain ordered statements.
  pushScopeIfNeeded(node, graphNodeId, category) {
    if (!graphNodeId) {
      return false;
    }

    const isContainer =
      category === "structure" ||
      (category === "statement" && FLOW_CONTAINER_TYPES.has(node.type));

    if (!isContainer) {
      return false;
    }

    this.scopeStack.push({
      syntaxNode: node,
      graphNodeId,
      statements: [],
    });
    return true;
  }

  // Register a statement so later passes can connect sequence and dependency edges.
  registerStatementSequence(node, graphNodeId) {
    const scope = this.findOwningFlowScope(node);
    if (!scope) {
      return;
    }

    scope.statements.push({
      syntaxNode: node,
      graphNodeId,
    });
    this.statementOrderByContainer.set(scope.graphNodeId, scope.statements);
  }

  // Find the nearest surrounding scope that owns the current statement sequence.
  findOwningFlowScope(node) {
    for (let index = this.scopeStack.length - 1; index >= 0; index -= 1) {
      const scope = this.scopeStack[index];
      if (scope.syntaxNode === node) {
        continue;
      }

      if (FLOW_CONTAINER_TYPES.has(scope.syntaxNode.type) || scope.syntaxNode.type.endsWith("_body")) {
        return scope;
      }
    }

    return null;
  }

  // Add reverse-dependency edges from a statement to the elements it uses.
  connectReverseDependencies(node, statementGraphNodeId) {
    const elements = collectElementNodes(node, this.resolveCategory.bind(this));
    const seen = new Set();

    for (const elementNode of elements) {
      const elementGraphNodeId = this.ensureNode(elementNode, "element");
      if (seen.has(elementGraphNodeId)) {
        continue;
      }

      seen.add(elementGraphNodeId);
      this.addEdge("redep", statementGraphNodeId, elementGraphNodeId, {
        relation: "uses-element",
      });
    }
  }

  // Add statement-order and local data-flow dependency edges after traversal.
  linkExecutionDependencies() {
    for (const [containerId, statements] of this.statementOrderByContainer.entries()) {
      for (let index = 0; index < statements.length; index += 1) {
        const current = statements[index];
        const previous = statements[index - 1];

        if (previous) {
          this.addEdge("str", previous.graphNodeId, current.graphNodeId, {
            relation: "next-statement",
            container: containerId,
          });
          this.addEdge("dep", previous.graphNodeId, current.graphNodeId, {
            relation: "control-flow",
            container: containerId,
          });
        }

        const referencedStatements = this.collectProducerStatementsBefore(statements, index, current.syntaxNode);
        for (const producer of referencedStatements) {
          this.addEdge("dep", producer.graphNodeId, current.graphNodeId, {
            relation: "data-flow",
            container: containerId,
          });
        }
      }
    }
  }

  // Find earlier statements that define identifiers used by the current statement.
  collectProducerStatementsBefore(statements, currentIndex, currentNode) {
    const usedIdentifiers = new Set(
      collectElementNodes(currentNode, this.resolveCategory.bind(this))
        .filter((node) => node.type === "identifier")
        .map((node) => sliceNodeText(this.sourceCode, node)),
    );

    if (usedIdentifiers.size === 0) {
      return [];
    }

    const producers = [];
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = statements[index];
      const declaredOrAssigned = this.collectDeclaredIdentifiers(candidate.syntaxNode);
      if (declaredOrAssigned.some((name) => usedIdentifiers.has(name))) {
        producers.push(candidate);
      }
    }

    return producers;
  }

  // Collect identifier names that act as definitions inside one syntax subtree.
  collectDeclaredIdentifiers(node) {
    const identifiers = [];
    const stack = [node];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      if (current.type === "identifier" && this.isDefiningIdentifier(current)) {
        identifiers.push(sliceNodeText(this.sourceCode, current));
      }

      stack.push(...current.namedChildren);
    }

    return identifiers;
  }

  // Decide whether an identifier is a definition based on its parent node kind.
  isDefiningIdentifier(node) {
    const parent = node.parent;
    if (!parent) {
      return false;
    }

    return DEFINING_PARENT_TYPES.has(parent.type);
  }

  // Add one deduplicated graph edge.
  addEdge(kind, source, target, extra = {}) {
    const edgeId = `${kind}:${source}->${target}:${extra.relation ?? ""}:${extra.container ?? ""}`;
    if (this.edgeIdSet.has(edgeId)) {
      return;
    }

    this.edgeIdSet.add(edgeId);
    this.edges.push({
      id: edgeId,
      kind,
      source,
      target,
      ...extra,
    });
  }
}

class SemanticCollector {
  // Initialize semantic-fact collection state for one Java file.
  constructor(sourceCode, options) {
    this.sourceCode = sourceCode;
    this.filePath = options.filePath ?? null;
    this.fileKey = options.filePath ?? "__memory__";
    this.packageName = "";
    this.imports = [];
    this.types = [];
    this.methods = [];
    this.constructors = [];
    this.fields = [];
    this.variables = [];
    this.methodInvocations = [];
    this.objectCreations = [];
    this.typeReferences = [];
    this.typeStack = [];
    this.methodStack = [];
  }

  // Materialize the collected semantic facts used by project-level resolution.
  toJSON() {
    return {
      filePath: this.filePath,
      packageName: this.packageName,
      imports: this.imports,
      types: this.types,
      methods: this.methods,
      constructors: this.constructors,
      fields: this.fields,
      variables: this.variables,
      methodInvocations: this.methodInvocations,
      objectCreations: this.objectCreations,
      typeReferences: this.typeReferences,
    };
  }

  // Start semantic collection from the AST root.
  collect(rootNode) {
    this.visit(rootNode);
  }

  // Walk the AST and dispatch to specialized semantic collectors.
  visit(node) {
    switch (node.type) {
      case "package_declaration":
        this.collectPackage(node);
        break;
      case "import_declaration":
        this.collectImport(node);
        break;
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "annotation_type_declaration":
      case "record_declaration":
        this.collectType(node);
        return;
      case "method_declaration":
        this.collectMethod(node);
        return;
      case "constructor_declaration":
        this.collectConstructor(node);
        return;
      case "field_declaration":
      case "constant_declaration":
        this.collectField(node);
        break;
      case "local_variable_declaration":
        this.collectLocalVariable(node);
        break;
      case "formal_parameter":
      case "spread_parameter":
      case "receiver_parameter":
      case "catch_formal_parameter":
        this.collectParameter(node);
        break;
      case "method_invocation":
        this.collectMethodInvocation(node);
        break;
      case "object_creation_expression":
        this.collectObjectCreation(node);
        break;
      default:
        break;
    }

    for (const child of node.namedChildren) {
      this.visit(child);
    }
  }

  // Record the package declaration of the current file.
  collectPackage(node) {
    const nameNode = node.namedChildren.find((child) => child.type === "identifier" || child.type === "scoped_identifier");
    if (nameNode) {
      this.packageName = sliceNodeText(this.sourceCode, nameNode);
    }
  }

  // Record one import declaration for later type resolution.
  collectImport(node) {
    const rawText = sliceNodeText(this.sourceCode, node);
    const nameNode = node.namedChildren.find((child) => child.type === "identifier" || child.type === "scoped_identifier");
    if (!nameNode) {
      return;
    }

    const targetName = sliceNodeText(this.sourceCode, nameNode);
    this.imports.push({
      nodeId: makeNodeId(node, this.fileKey),
      targetName,
      isStatic: /\bstatic\b/.test(rawText),
      isWildcard: rawText.includes("*"),
      text: rawText,
    });
  }

  // Record one declared type and recurse within its nested scope.
  collectType(node) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) {
      return;
    }

    const simpleName = sliceNodeText(this.sourceCode, nameNode);
    const qualifiedName = this.makeQualifiedTypeName(simpleName);
    const typeFact = {
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      kind: node.type,
      simpleName,
      qualifiedName,
      superclassNames: extractTypeNames(this.sourceCode, node.childForFieldName("superclass")),
      interfaceNames: extractTypeNames(this.sourceCode, node.childForFieldName("interfaces")),
    };

    this.types.push(typeFact);
    this.typeStack.push(typeFact);
    for (const child of node.namedChildren) {
      this.visit(child);
    }
    this.typeStack.pop();
  }

  // Record one method declaration, its signature, and local bindings.
  collectMethod(node) {
    const currentType = this.currentType();
    const nameNode = node.childForFieldName("name");
    if (!currentType || !nameNode) {
      for (const child of node.namedChildren) {
        this.visit(child);
      }
      return;
    }

    const methodFact = {
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      ownerQualifiedName: currentType.qualifiedName,
      name: sliceNodeText(this.sourceCode, nameNode),
      paramCount: 0,
      parameterTypeNames: [],
      returnTypeName: normalizeTypeName(sliceNodeText(this.sourceCode, node.childForFieldName("type"))),
      localBindings: [],
    };

    const parameterContainer = node.childForFieldName("parameters");
    if (parameterContainer) {
      const parameterNodes = parameterContainer.namedChildren.filter((child) => child.type.endsWith("_parameter"));
      methodFact.paramCount = parameterNodes.length;
      for (const parameterNode of parameterNodes) {
        const parameterTypeName = normalizeTypeName(nodeText(this.sourceCode, inferDeclaredTypeNode(parameterNode)));
        if (parameterTypeName) {
          methodFact.parameterTypeNames.push(parameterTypeName);
        }
      }
    }

    if (methodFact.returnTypeName) {
      this.typeReferences.push({
        filePath: this.filePath,
        nodeId: methodFact.nodeId,
        rawTypeName: methodFact.returnTypeName,
        context: "return-type",
      });
    }

    this.methods.push(methodFact);
    this.methodStack.push(methodFact);
    for (const child of node.namedChildren) {
      this.visit(child);
    }
    this.methodStack.pop();
  }

  // Record one constructor declaration and its local bindings.
  collectConstructor(node) {
    const currentType = this.currentType();
    const nameNode = node.childForFieldName("name");
    if (!currentType || !nameNode) {
      for (const child of node.namedChildren) {
        this.visit(child);
      }
      return;
    }

    const constructorFact = {
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      ownerQualifiedName: currentType.qualifiedName,
      name: sliceNodeText(this.sourceCode, nameNode),
      paramCount: 0,
      parameterTypeNames: [],
      localBindings: [],
    };

    const parameterContainer = node.childForFieldName("parameters");
    if (parameterContainer) {
      const parameterNodes = parameterContainer.namedChildren.filter((child) => child.type.endsWith("_parameter"));
      constructorFact.paramCount = parameterNodes.length;
      for (const parameterNode of parameterNodes) {
        const parameterTypeName = normalizeTypeName(nodeText(this.sourceCode, inferDeclaredTypeNode(parameterNode)));
        if (parameterTypeName) {
          constructorFact.parameterTypeNames.push(parameterTypeName);
        }
      }
    }

    this.constructors.push(constructorFact);
    this.methodStack.push(constructorFact);
    for (const child of node.namedChildren) {
      this.visit(child);
    }
    this.methodStack.pop();
  }

  // Record one field declaration and its declared type.
  collectField(node) {
    const currentType = this.currentType();
    if (!currentType) {
      return;
    }

    const typeName = normalizeTypeName(nodeText(this.sourceCode, inferDeclaredTypeNode(node)));
    if (typeName) {
      this.typeReferences.push({
        filePath: this.filePath,
        nodeId: makeNodeId(node, this.fileKey),
        rawTypeName: typeName,
        context: "field-type",
      });
    }

    for (const declarator of findChildrenByType(node, "variable_declarator")) {
      const nameNode = declarator.childForFieldName("name") ?? declarator.namedChildren.find((child) => child.type === "identifier");
      if (!nameNode) {
        continue;
      }
      const variableFact = {
        filePath: this.filePath,
        nodeId: makeNodeId(node, this.fileKey),
        ownerQualifiedName: currentType.qualifiedName,
        name: sliceNodeText(this.sourceCode, nameNode),
        typeName,
        kind: "field",
        isConstant: node.type === "constant_declaration" || /\bfinal\b/.test(sliceNodeText(this.sourceCode, node)),
        enclosingCallableNodeId: null,
      };
      this.fields.push(variableFact);
      this.variables.push(variableFact);
    }
  }

  // Record one local-variable declaration for later receiver and data-flow analysis.
  collectLocalVariable(node) {
    const currentMethod = this.currentMethod();
    if (!currentMethod) {
      return;
    }

    const typeName = normalizeTypeName(nodeText(this.sourceCode, inferDeclaredTypeNode(node)));
    if (typeName) {
      this.typeReferences.push({
        filePath: this.filePath,
        nodeId: makeNodeId(node, this.fileKey),
        rawTypeName: typeName,
        context: "local-type",
      });
    }

    for (const declarator of findChildrenByType(node, "variable_declarator")) {
      const nameNode = declarator.childForFieldName("name") ?? declarator.namedChildren.find((child) => child.type === "identifier");
      if (!nameNode) {
        continue;
      }

      currentMethod.localBindings.push({
        name: sliceNodeText(this.sourceCode, nameNode),
        typeName,
        declaredAt: node.startIndex,
      });
      this.variables.push({
        filePath: this.filePath,
        nodeId: makeNodeId(node, this.fileKey),
        ownerQualifiedName: this.currentType()?.qualifiedName ?? null,
        name: sliceNodeText(this.sourceCode, nameNode),
        typeName,
        kind: "local",
        isConstant: /\bfinal\b/.test(sliceNodeText(this.sourceCode, node)),
        enclosingCallableNodeId: currentMethod.nodeId,
      });
    }
  }

  // Record one parameter as a local binding and type reference.
  collectParameter(node) {
    const currentMethod = this.currentMethod();
    if (!currentMethod) {
      return;
    }

    const nameNode = node.namedChildren.find((child) => child.type === "identifier");
    const typeName = normalizeTypeName(nodeText(this.sourceCode, inferDeclaredTypeNode(node)));
    if (!nameNode || !typeName) {
      return;
    }

    currentMethod.localBindings.push({
      name: sliceNodeText(this.sourceCode, nameNode),
      typeName,
      declaredAt: node.startIndex,
    });
    this.variables.push({
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      ownerQualifiedName: this.currentType()?.qualifiedName ?? null,
      name: sliceNodeText(this.sourceCode, nameNode),
      typeName,
      kind: "parameter",
      isConstant: false,
      enclosingCallableNodeId: currentMethod.nodeId,
    });
    this.typeReferences.push({
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      rawTypeName: typeName,
      context: "parameter-type",
    });
  }

  // Record one invocation site with enough context for later call resolution.
  collectMethodInvocation(node) {
    this.methodInvocations.push({
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      name: nodeText(this.sourceCode, node.childForFieldName("name")),
      objectText: nodeText(this.sourceCode, node.childForFieldName("object")),
      argumentCount: node.childForFieldName("arguments")?.namedChildCount ?? 0,
      enclosingTypeQualifiedName: this.currentType()?.qualifiedName ?? null,
      enclosingCallableNodeId: this.currentMethod()?.nodeId ?? null,
      startIndex: node.startIndex,
    });
  }

  // Record one object creation site and its constructed type.
  collectObjectCreation(node) {
    const typeName = normalizeTypeName(nodeText(this.sourceCode, node.childForFieldName("type")));
    if (!typeName) {
      return;
    }

    this.objectCreations.push({
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      typeName,
      argumentCount: node.childForFieldName("arguments")?.namedChildCount ?? 0,
      enclosingTypeQualifiedName: this.currentType()?.qualifiedName ?? null,
      enclosingCallableNodeId: this.currentMethod()?.nodeId ?? null,
      startIndex: node.startIndex,
    });
    this.typeReferences.push({
      filePath: this.filePath,
      nodeId: makeNodeId(node, this.fileKey),
      rawTypeName: typeName,
      context: "constructed-type",
    });
  }

  // Return the innermost enclosing type fact, if any.
  currentType() {
    return this.typeStack[this.typeStack.length - 1] ?? null;
  }

  // Return the innermost enclosing method or constructor fact, if any.
  currentMethod() {
    return this.methodStack[this.methodStack.length - 1] ?? null;
  }

  // Build a qualified type name relative to the current nesting and package.
  makeQualifiedTypeName(simpleName) {
    const ownerType = this.currentType();
    if (ownerType) {
      return `${ownerType.qualifiedName}.${simpleName}`;
    }
    if (this.packageName) {
      return `${this.packageName}.${simpleName}`;
    }
    return simpleName;
  }
}

// Slice compact source text for one AST node.
function sliceNodeText(sourceCode, node) {
  return sourceCode.slice(node.startIndex, node.endIndex).replace(/\s+/g, " ").trim();
}

// Slice node text or return null when the node is missing.
function nodeText(sourceCode, node) {
  return node ? sliceNodeText(sourceCode, node) : null;
}

// Build a file-scoped graph node identifier from syntax coordinates.
function makeNodeId(node, fileKey) {
  return `${fileKey}#${node.type}:${node.startIndex}:${node.endIndex}`;
}

// Collect descendant element nodes beneath one syntax node.
function collectElementNodes(node, resolveCategory) {
  const result = [];
  const stack = [...node.namedChildren];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (resolveCategory(current) === "element") {
      result.push(current);
      continue;
    }

    stack.push(...current.namedChildren);
  }

  return result;
}

// Infer the declared type child for declarations and parameters.
function inferDeclaredTypeNode(node) {
  for (const child of node.namedChildren) {
    if (child.type === "modifiers" || child.type === "variable_declarator" || child.type === "identifier") {
      continue;
    }
    return child;
  }
  return null;
}

// Return named children of a specific Tree-sitter type.
function findChildrenByType(node, type) {
  return node.namedChildren.filter((child) => child.type === type);
}

// Extract referenced type names from extends or implements clauses.
function extractTypeNames(sourceCode, node) {
  if (!node) {
    return [];
  }

  const cleaned = sliceNodeText(sourceCode, node)
    .replace(/^extends\s+/, "")
    .replace(/^implements\s+/, "");
  return splitTopLevel(cleaned, ",")
    .map((part) => normalizeTypeName(part))
    .filter(Boolean);
}

// Split a comma-separated list while preserving nested generic fragments.
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

// Normalize Java type text into a resolvable non-primitive type name.
export function normalizeTypeName(rawTypeName) {
  if (!rawTypeName) {
    return null;
  }

  let text = rawTypeName
    .replace(/^@\S+\s+/g, "")
    .replace(/\bextends\b/g, "")
    .replace(/\bimplements\b/g, "")
    .replace(/\bfinal\b/g, "")
    .replace(/\?/g, "")
    .replace(/\bsuper\b/g, "")
    .trim();

  text = stripGenericArguments(text);
  text = text.replace(/\[\]/g, "").replace(/\.\.\./g, "").trim();
  if (!text) {
    return null;
  }

  const primitiveOrVoid = new Set([
    "byte",
    "short",
    "int",
    "long",
    "float",
    "double",
    "boolean",
    "char",
    "void",
  ]);

  return primitiveOrVoid.has(text) ? null : text;
}

// Remove generic argument payload while preserving the outer type name.
function stripGenericArguments(text) {
  let result = "";
  let depth = 0;

  for (const char of text) {
    if (char === "<") {
      depth += 1;
      continue;
    }
    if (char === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      result += char;
    }
  }

  return result.replace(/\s+/g, " ").trim();
}

export const JAVA_GRAPH_CONSTANTS = {
  TYPE_DECLARATION_TYPES,
};
