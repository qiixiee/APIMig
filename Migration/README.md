# Construct Project Graph
Builds a heterogeneous dependency graph for a Java source file or Java project directory.

## Graph Model
Nodes have three categories:
- `structure`: structural containers such as `class_body`, `method_declaration`, and `block`.
- `statement`: declarations and executable statements, such as variable declarations, method invocations, and return statements.
- `element`: leaf-level code elements, such as identifiers, literals, and field accesses.

Edges have three categories:
- `str`: structural containment or sibling statement order.
- `dep`: forward execution, data, or semantic dependency.
- `redep`: reverse dependency from a statement to an element it uses.

## Installation
```bash
npm install
```

## Usage
```bash
# Build a graph for one Java file.
node ./src/cli.js ./path/to/YourFile.java

# Build a graph for a Java project and print a summary only.
node ./src/cli.js ./path/to/java-project --summary

# Run the included project example.
node ./src/cli.js ./examples/project-demo --summary

# Run callsite analysis from a change specification.
node ./src/cli.js ./examples/project-demo --change-spec ./examples/change-specs/project-demo-method-overall.json
```

The command prints JSON. A graph result has the following shape:
```json
{
  "meta": {
    "language": "java",
    "nodeCount": 0,
    "edgeCount": 0
  },
  "nodes": [],
  "edges": []
}
```

## Callsite Analysis
Callsite Analysis: identifies callsites affected by an API change, along with Before Callsite and After Callsite nodes.
Chain Exploration Algorithm (CEA): groups `{ BCS, Callsite, ACS }` blocks according to dependency order.

### Change Specification
Callsite analysis reads a JSON specification supplied through `--change-spec`:

#### Supported Target Granularities
- `Class/Interface`
- `Method/Constructor`
- `Constant/Variable`

#### Change Scopes

- Class/interface: `Name`, `Extends/Implements`.
- Method/constructor: `Name`, `Modifier`, `ReturnType`, `ReturnValue`, `ParamList`, `Overall`.
- Constant/variable: `Name`, `DataType`, `Value`.

A constant or variable target must be uniquely identifiable inside the project. Provide `name`, `ownerQualifiedName`, and `filePath`; for a local variable or parameter, `enclosingCallableNodeId` can also be provided. If candidates remain ambiguous, analysis returns `unresolved-target` to avoid cross-scope false positives.

```json
{
  "granularity": "Constant/Variable",
  "scope": "Value",
  "target": {
    "name": "result",
    "ownerQualifiedName": "demo.app.ReportService",
    "filePath": "xxx",
    "variableKind": "local"
  }
}
```

## Analysis Result
Callsite analysis returns:

- `callsites`: identified affected callsite nodes.
- `callsiteBlocks`: CEA-ordered `{ beforeCallsite, callsite, afterCallsite }` blocks.

For batch changes, callsites from all requested API changes are merged into one list before CEA runs. Each result carries a `changeIndex` identifying its source change.

For external methods whose receiver type cannot be inferred from source, matching falls back to method name plus argument count. This can produce false positives for methods with the same name.

## Migration Code Generation

Based on `callsiteBlocks`, generate a migration prompt for each affected code block:

```bash
node ./src/cli.js ./examples/project-demo --migration-spec ./examples/change-specs/project-demo-migration.json
```
can be invoked directly:

```bash
python3 ./src/migration_generator.py ./examples/project-demo --migration-spec ./examples/change-specs/project-demo-migration.json
```

Example migration specification:

```json
{
  "libraryName": "demo.shared",
  "sourceVersion": "1.0.0",
  "targetVersion": "2.0.0",
  "changeInformation": "The method demo.shared.BaseService.format(String) is changed. The caller should adapt the affected parameter preparation, callsite, and return value usage statements.",
  "includeMethodBody": true,
  "changeSpec": {
    "granularity": "Method/Constructor",
    "scope": "Overall",
    "target": {
      "signature": "demo.shared.BaseService.format(String)"
    }
  }
}
```

The `tasks` field in the output maps one-to-one to CEA `callsiteBlocks`. Each task contains:

- `targetCodeSnippet`: the target code snippet assembled from `Before Callsite`, `Callsite`, and `After Callsite`.
- `methodBody`: the optional source code of the enclosing method or constructor.
- `prompt`: the complete prompt generated from an APIMig-style template.

By default, the tool only generates prompts and does not call any external model. To directly request an OpenAI-compatible API and generate migration code:

```bash
MIGRATION_API_KEY=your_key
MIGRATION_BASE_URL=https://api.openai.com/v1
MIGRATION_MODEL=gpt-4o-mini
node ./src/cli.js ./examples/project-demo --migration-spec ./examples/change-specs/project-demo-migration.json --execute-migration
```

Model responses are stored in `results`. 