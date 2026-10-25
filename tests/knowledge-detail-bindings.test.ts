import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

test("Knowledge detail components have no unbound render identifiers", () => {
  const file = resolve("frontend/src/pages/KnowledgeProject.tsx");
  const program = ts.createProgram([file], { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true });
  const unbound = program.getSemanticDiagnostics(program.getSourceFile(file)).filter(d => d.code === 2304);
  assert.deepEqual(unbound.map(d => ts.flattenDiagnosticMessageText(d.messageText, " ")), []);
});
