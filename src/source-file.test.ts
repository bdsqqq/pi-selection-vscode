import assert from "node:assert/strict";
import test from "node:test";
import { chooseSourcePath, isPathWithinRoot, parseSourceFile } from "./source-file";

test("parseSourceFile reads locations from the right and decodes file URLs", () => {
  assert.deepEqual(parseSourceFile("src/button.tsx:42:7"), {
    file: "src/button.tsx",
    line: 42,
    column: 7,
  });
  assert.deepEqual(parseSourceFile("file:///work/app/src/button.tsx:3"), {
    file: "/work/app/src/button.tsx",
    line: 3,
    column: 1,
  });
  assert.equal(parseSourceFile("src/button.tsx:0"), undefined);
});

test("chooseSourcePath resolves exact and unique suffix paths inside cwd", () => {
  const candidates = [
    { path: "/work/app/src/button.tsx", realPath: "/work/app/src/button.tsx" },
    {
      path: "/work/app/packages/card/src/card.tsx",
      realPath: "/work/app/packages/card/src/card.tsx",
    },
  ];
  assert.equal(
    chooseSourcePath("/work/app/src/button.tsx", "/work/app", candidates),
    "/work/app/src/button.tsx",
  );
  assert.equal(
    chooseSourcePath("src/card.tsx", "/work/app", candidates),
    "/work/app/packages/card/src/card.tsx",
  );
});

test("chooseSourcePath rejects traversal, symlink escapes, and ambiguous suffixes", () => {
  assert.equal(
    chooseSourcePath("../secret.ts", "/work/app", [
      { path: "/work/secret.ts", realPath: "/work/secret.ts" },
    ]),
    undefined,
  );
  assert.equal(
    chooseSourcePath("linked.ts", "/work/app", [
      { path: "/work/app/linked.ts", realPath: "/private/secret.ts" },
    ]),
    undefined,
  );
  assert.equal(
    chooseSourcePath("card.tsx", "/work/app", [
      { path: "/work/app/src/card.tsx", realPath: "/work/app/src/card.tsx" },
      { path: "/work/app/test/card.tsx", realPath: "/work/app/test/card.tsx" },
    ]),
    undefined,
  );
  assert.equal(isPathWithinRoot("/work/app", "/work/application/file.ts"), false);
});
