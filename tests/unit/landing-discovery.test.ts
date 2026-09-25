import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("shared landing page renders v2 schema paths and preserves them for lazy columns", async () => {
  const html = await Bun.file(new URL("../../public/landing.html", import.meta.url)).text();
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
  const window = new Window({ url: "https://worker.test/" });
  // Bun does not populate every intrinsic in Happy DOM's VM context.
  window.SyntaxError = SyntaxError;
  window.document.write(html.replace(/<script type="module">[\s\S]*?<\/script>/, ""));
  const paths = [["main"], ["region.with.dot", "public"], ["region", "with.dot.public"]];
  const requests: string[][] = [];
  const checkPath = (path: string[]) => {
    expect(paths).toContainEqual(path);
    requests.push(path);
  };
  class Client {
    async catalogsInfo() { return [{ name: "demo", attach_option_specs: [], releases: [] }]; }
    async catalogAttach() { return { attach_opaque_data: new Uint8Array([1]), tags: {} }; }
    async schemas() { return paths.map(path => ({ path, tags: {} })); }
    async schemaContentsTables(_aod: unknown, path: string[]) {
      checkPath(path);
      return [{ name: "prices", columns: new Uint8Array([1]) }];
    }
    async schemaContentsViews(_aod: unknown, path: string[]) { checkPath(path); return []; }
    async schemaContentsFunctions(_aod: unknown, path: string[]) { checkPath(path); return []; }
    async schemaContentsMacros(_aod: unknown, path: string[]) { checkPath(path); return []; }
  }
  const bundle = {
    VgiClient: Client, httpConnect: () => ({}), deserializeAttachOptionSpecs: () => [],
    deserializeSchema: () => ({ fields: [{ name: "price", type: { typeId: 3, precision: 2 } }] }),
    schemaToArgumentSpecs: () => [], TypeId: { Float: 3 },
  };
  // Run the actual page's module body with deterministic discovery responses.
  // The SDK tests separately execute the vendored bundle against real RPC.
  const body = script
    .replace(/import \{([\s\S]*?)\} from '\.\/vgi-client\.js[^']*';/, "const {$1} = bundle;")
    .replace(/boot\(\);\s*$/, "return {boot, fetchColumns, exampleTable};");
  const page = new Function("bundle", "document", "location", "fetch", body)(
    bundle, window.document, window.location,
    async () => Response.json({ worker: "demo", lang: "typescript", version: "test" }),
  );
  try {
    await page.boot();
    expect(window.document.querySelector(".noresults")).toBeNull();
    expect(window.document.querySelectorAll("details.schema")).toHaveLength(3);
    expect(window.document.querySelector("#cat-sub")!.textContent).toContain("3 tables");
    const tablePaths = [...window.document.querySelectorAll("details.tbl")]
      .map(row => JSON.parse(row.getAttribute("data-schema")!));
    expect(tablePaths).toHaveLength(3);
    for (const path of paths) expect(tablePaths).toContainEqual(path);
    const before = requests.length;
    for (const path of tablePaths) {
      expect(await page.fetchColumns("demo", path, "prices"))
        .toEqual({ columns: [{ name: "price", type: "DOUBLE", comment: "" }] });
    }
    // The two dotted display names collide, but their path identities must not.
    expect(requests.length - before).toBe(3);
    expect(page.exampleTable({ schemas: [{ path: paths[1], tables: [{ name: "prices" }] }] }))
      .toBe('"region.with.dot".public.prices');
  } finally {
    await window.happyDOM.close();
  }
});
