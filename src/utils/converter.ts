import type {
  PostmanAuth,
  PostmanCollection,
  PostmanEnvironmentExport,
  PostmanFormParam,
  PostmanRequest,
  PostmanRequestBody,
  PostmanItem,
} from "./types";
import { isPostmanFolder, isPostmanEnvironmentExport, normalizePostmanUrl, convertColonPathParams, extractPostmanPathParams, getAuthParam, extractDescriptionText } from "./types";
import { getVoidenApiHelpers } from "./useVoidenApiHelpers";


/**
 * Voiden's headers/query/path tables only show a Description column once at
 * least one row actually has one (see Table.tsx's `showAddDescription` — the
 * column count of the first row decides whether the column renders). Drop
 * the 3rd element back down to a plain 2-tuple when nothing has a
 * description, so imports without them keep the existing 2-column table
 * (with its "+ Description" affordance) instead of always showing an empty
 * Description column.
 */
function withOptionalDescriptions(
  rows: [string, string, string][]
): [string, string][] | [string, string, string][] {
  return rows.some((row) => row[2]) ? rows : rows.map(([key, value]) => [key, value] as [string, string]);
}

/**
 * Sanitize folder/file names to be filesystem-safe
 */
export function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\/+/g, "-") // Replace one or more slashes with a dash
    .replace(/[^a-zA-Z0-9-\s]/g, "") // Remove any character that is not alphanumeric, a dash, or whitespace
    .replace(/\s+/g, "-") // Replace whitespace with a dash
    .replace(/-+/g, "-") // Collapse multiple dashes into one
    .replace(/^-+/, "") // Remove leading dashes
    .replace(/-+$/, ""); // Remove trailing dashes
}

/**
 * Build a tableCell node. `content` is the cell's paragraph content
 * (plain text, or a fileLink node for multipart file fields).
 */
function makeTableCell(content: any[]) {
  return {
    type: "tableCell",
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [{ type: "paragraph", content }],
  };
}

function makeTextCell(text?: string) {
  return makeTableCell(text ? [{ type: "text", text }] : []);
}

/**
 * Build a `table` node (the same shape voiden-rest-api's convertDataToTableNode
 * produces) from plain text rows.
 */
function buildTableContent(rows: Array<[string, string]>) {
  return [
    {
      type: "table",
      content: rows.map(([key, value]) => ({
        type: "tableRow",
        attrs: { disabled: false },
        content: [makeTextCell(key), makeTextCell(value)],
      })),
    },
  ];
}

/**
 * Convert Postman's `auth` config into a Voiden `auth` block.
 * Postman stores every auth sub-config (basic, bearer, oauth2, ...) as an
 * array of {key, value} pairs — see getAuthParam in ./types.
 */
function buildAuthBlock(auth?: PostmanAuth): any | null {
  if (!auth || !auth.type || auth.type === "noauth") return null;

  const rows: Array<[string, string]> = [];
  let authType: string;

  switch (auth.type) {
    case "basic": {
      authType = "basic";
      const username = getAuthParam(auth.basic, "username");
      const password = getAuthParam(auth.basic, "password");
      if (username !== undefined) rows.push(["username", username]);
      if (password !== undefined) rows.push(["password", password]);
      break;
    }
    case "bearer": {
      authType = "bearer";
      const token = getAuthParam(auth.bearer, "token");
      if (token !== undefined) rows.push(["token", token]);
      break;
    }
    case "apikey": {
      authType = "apiKey";
      const key = getAuthParam(auth.apikey, "key");
      const value = getAuthParam(auth.apikey, "value");
      const addTo = getAuthParam(auth.apikey, "in") || "header";
      if (key !== undefined) rows.push(["key", key]);
      if (value !== undefined) rows.push(["value", value]);
      rows.push(["add_to", addTo]);
      break;
    }
    case "oauth2": {
      authType = "oauth2";
      const accessToken = getAuthParam(auth.oauth2, "accessToken");
      const tokenType = getAuthParam(auth.oauth2, "tokenType") || "Bearer";
      const headerPrefix = getAuthParam(auth.oauth2, "headerPrefix") || "Bearer";
      if (accessToken !== undefined) rows.push(["access_token", accessToken]);
      rows.push(["token_type", tokenType]);
      rows.push(["header_prefix", headerPrefix]);
      break;
    }
    case "oauth1": {
      authType = "oauth1";
      const consumerKey = getAuthParam(auth.oauth1, "consumerKey");
      const consumerSecret = getAuthParam(auth.oauth1, "consumerSecret");
      const accessToken = getAuthParam(auth.oauth1, "token");
      const tokenSecret = getAuthParam(auth.oauth1, "tokenSecret");
      const signatureMethod = getAuthParam(auth.oauth1, "signatureMethod") || "HMAC-SHA1";
      if (consumerKey !== undefined) rows.push(["consumer_key", consumerKey]);
      if (consumerSecret !== undefined) rows.push(["consumer_secret", consumerSecret]);
      if (accessToken !== undefined) rows.push(["access_token", accessToken]);
      if (tokenSecret !== undefined) rows.push(["token_secret", tokenSecret]);
      rows.push(["signature_method", signatureMethod]);
      break;
    }
    case "digest": {
      authType = "digest";
      const username = getAuthParam(auth.digest, "username");
      const password = getAuthParam(auth.digest, "password");
      if (username !== undefined) rows.push(["username", username]);
      if (password !== undefined) rows.push(["password", password]);
      break;
    }
    case "awsv4": {
      authType = "awsSignature";
      const accessKey = getAuthParam(auth.awsv4, "accessKey");
      const secretKey = getAuthParam(auth.awsv4, "secretKey");
      const region = getAuthParam(auth.awsv4, "region") || "us-east-1";
      const service = getAuthParam(auth.awsv4, "service") || "execute-api";
      const sessionToken = getAuthParam(auth.awsv4, "sessionToken");
      if (accessKey !== undefined) rows.push(["access_key", accessKey]);
      if (secretKey !== undefined) rows.push(["secret_key", secretKey]);
      rows.push(["region", region]);
      rows.push(["service", service]);
      if (sessionToken !== undefined) rows.push(["session_token", sessionToken]);
      break;
    }
    case "ntlm": {
      authType = "ntlm";
      const username = getAuthParam(auth.ntlm, "username");
      const password = getAuthParam(auth.ntlm, "password");
      const domain = getAuthParam(auth.ntlm, "domain");
      if (username !== undefined) rows.push(["username", username]);
      if (password !== undefined) rows.push(["password", password]);
      if (domain !== undefined) rows.push(["domain", domain]);
      break;
    }
    case "hawk": {
      authType = "hawk";
      const id = getAuthParam(auth.hawk, "authId");
      const key = getAuthParam(auth.hawk, "authKey");
      const algorithm = getAuthParam(auth.hawk, "algorithm") || "sha256";
      if (id !== undefined) rows.push(["id", id]);
      if (key !== undefined) rows.push(["key", key]);
      rows.push(["algorithm", algorithm]);
      break;
    }
    default:
      // Unsupported type (e.g. edgegrid) — skip rather than guess at a shape
      return null;
  }

  if (rows.length === 0) return null;

  return {
    type: "auth",
    attrs: { authType },
    content: buildTableContent(rows),
  };
}

/**
 * Build a single multipart-table row, resolving file fields (type: "file")
 * to a fileLink node when the file exists on this machine, since Postman's
 * `src` path almost always points at the exporting user's filesystem.
 */
async function buildMultipartRow(field: PostmanFormParam): Promise<any> {
  const keyCell = makeTextCell(field.key);

  if (field.type === "file") {
    const src = Array.isArray(field.src) ? field.src[0] : field.src;
    if (src) {
      try {
        const result = await (window as any).electron?.files?.hash?.(src);
        if (result?.exists) {
          const filename = src.split(/[\\/]/).pop() ?? src;
          return {
            type: "tableRow",
            attrs: { disabled: false },
            content: [keyCell, makeTableCell([{ type: "fileLink", attrs: { filePath: src, filename, isExternal: true } }])],
          };
        }
      } catch { /* best-effort existence check */ }
    }
    // File isn't resolvable on this machine — keep the original path visible as text
    // rather than silently dropping it.
    return { type: "tableRow", attrs: { disabled: false }, content: [keyCell, makeTextCell(src || "")] };
  }

  return { type: "tableRow", attrs: { disabled: false }, content: [keyCell, makeTextCell(field.value || "")] };
}

/**
 * Detect a GraphQL operation's type from its query text.
 */
function detectGraphqlOperationType(query: string): "query" | "mutation" | "subscription" {
  const match = query.match(/\b(query|mutation|subscription)\b/);
  return (match?.[1] as "query" | "mutation" | "subscription") || "query";
}

/**
 * Convert a Postman pre-request/test script into a non-executing Voiden
 * pre_script/post_script block. Postman scripts use the pm.* API while
 * Voiden scripts use a different voiden.* / vd.* API, so a literal translation
 * isn't safe to automate — the script is commented out so it's preserved
 * for manual review instead of erroring or silently disappearing.
 */
function buildScriptBlock(type: "pre_script" | "post_script", exec: string[] | string | undefined): any | null {
  const lines = Array.isArray(exec) ? exec : typeof exec === "string" ? exec.split(/\r?\n/) : [];
  if (!lines.some((line) => line.trim() !== "")) return null;

  const header = [
    "// Imported from a Postman pm.* script.",
    "// Commented out: Voiden scripts use the voiden.* / vd.* API, not pm.*.",
    "// Review and adapt this logic, then uncomment — see the scripting skill docs.",
    "",
  ];
  const commented = lines.map((line) => (line.trim() === "" ? "" : `// ${line}`));

  return {
    type,
    attrs: { language: "javascript", body: [...header, ...commented].join("\n") },
  };
}

/**
 * Detect language from raw body
 */
function detectBodyLanguage(body: PostmanRequestBody): 'json' | 'xml' | 'html' | 'text' {
  // Check explicit language setting
  const language = body.options?.raw?.language;
  if (language === 'json' || language === 'xml' || language === 'html' || language === 'text') {
    return language;
  }

  // Try to detect from content
  if (body.raw) {
    const trimmed = body.raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    if (trimmed.startsWith('<')) {
      if (trimmed.toLowerCase().includes('<!doctype html') || trimmed.toLowerCase().includes('<html')) {
        return 'html';
      }
      return 'xml';
    }
  }

  return 'text';
}

/**
 * Convert a Postman request to Voiden .void file format
 * Uses voiden-rest-api helpers to create blocks properly
 */
export const convertPostmanRequestToVoidenSchema = async (data: PostmanRequest): Promise<string> => {
  try {
    const helpers = getVoidenApiHelpers();

    // Build voiden blocks using the exposed helpers
    const blocks: any[] = [];

    const url = convertColonPathParams(normalizePostmanUrl(data.request.url));
    // GraphQL requests use a gqlquery container — the URL lives inside gqlurl,
    // not in a request block.
    const isGraphQL = data.request.body?.mode === "graphql" && !!data.request.body?.graphql?.query;

    // 1. Request block (method + url) — skipped for GraphQL
    if (!isGraphQL) {
      blocks.push({
        type: 'request',
        content: [
          helpers.createMethodNode(data.request.method),
          helpers.createUrlNode(url)
        ]
      });
    }

    // 2. Auth — dedicated auth block (covers basic/bearer/apikey/oauth2/oauth1/digest/ntlm/awsv4/hawk)
    const authBlock = buildAuthBlock(data.request.auth);
    if (authBlock) {
      blocks.push(authBlock);
    }

    // 2a. Pre-request scripts — imported commented-out (see buildScriptBlock)
    for (const event of data.event || []) {
      if (event.disabled || event.listen !== "prerequest") continue;
      const scriptBlock = buildScriptBlock("pre_script", event.script?.exec);
      if (scriptBlock) blocks.push(scriptBlock);
    }

    // 3. Headers
    // Filter out disabled headers
    const activeHeaders = (data.request.header || []).filter(h => !h.disabled);

    if (activeHeaders.length > 0) {
      const headersBlock = helpers.createHeadersTableNode(
        withOptionalDescriptions(
          activeHeaders.map(h => [h.key, h.value, extractDescriptionText(h.description)] as [string, string, string])
        )
      );
      blocks.push(headersBlock);
    }

    // 3b. Path parameters — from Postman's url.variable, or inferred from :name segments
    const pathParams = extractPostmanPathParams(data.request.url);
    if (pathParams.length > 0) {
      blocks.push(helpers.createPathParamsTableNode(withOptionalDescriptions(pathParams)));
    }

    // 3c. Query parameters (v2.1.0 format)
    // Filter out disabled query params
    if (typeof data.request.url === 'object' && data.request.url.query && data.request.url.query.length > 0) {
      const activeQueries = data.request.url.query.filter(q => !q.disabled);
      if (activeQueries.length > 0) {
        const queryBlock = helpers.createQueryTableNode(
          withOptionalDescriptions(
            activeQueries.map(q => [q.key, q.value, extractDescriptionText(q.description)] as [string, string, string])
          )
        );
        blocks.push(queryBlock);
      }
    }

    // 4. Request Body
    if (data.request.body) {
      const body = data.request.body;

      // 4a. Raw body (JSON, XML, HTML, Text)
      if (body.mode === "raw" && body.raw) {
        const language = detectBodyLanguage(body);

        if (language === 'json') {
          blocks.push(helpers.createJsonBodyNode(body.raw, "json"));
        } else if (language === 'xml') {
          blocks.push(helpers.createXMLBodyNode(body.raw, "xml"));
        } else if (language === 'html') {
          blocks.push(helpers.createXMLBodyNode(body.raw, "html"));
        } else {
          // For plain text, use JSON body node with text type
          blocks.push(helpers.createJsonBodyNode(body.raw, "text"));
        }
      }

      // 4b. URL-encoded form data (application/x-www-form-urlencoded)
      else if (body.mode === "urlencoded" && body.urlencoded && body.urlencoded.length > 0) {
        const activeParams = body.urlencoded.filter(f => !f.disabled);
        if (activeParams.length > 0) {
          const urlencodedBlock = helpers.createUrlTableNode(
            activeParams.map(f => [f.key, f.value] as [string, string])
          );
          blocks.push(urlencodedBlock);
        }
      }

      // 4c. Multipart form data
      else if (body.mode === "formdata" && body.formdata && body.formdata.length > 0) {
        const activeFormData = body.formdata.filter(f => !f.disabled);
        if (activeFormData.length > 0) {
          if (activeFormData.some(f => f.type === "file")) {
            // At least one file field — build the table manually so file
            // paths become fileLink nodes instead of being dropped as text.
            const rows = await Promise.all(activeFormData.map(buildMultipartRow));
            blocks.push({ type: "multipart-table", content: [{ type: "table", content: rows }] });
          } else {
            const multipartBlock = helpers.createMultipartTableNode(
              activeFormData.map(f => [f.key, f.value || ""] as [string, string])
            );
            blocks.push(multipartBlock);
          }
        }
      }

      // 4d. GraphQL body — container format: gqlquery > [gqlurl, gqlbody]
      // The URL is carried in the gqlurl child (not in a request block).
      // Normalize CRLF to LF so the YAML serializer doesn't produce escaped
      // single-line strings for multi-line queries.
      else if (isGraphQL) {
        const query = (body.graphql!.query as string).replace(/\r\n/g, "\n");
        blocks.push({
          type: "gqlquery",
          attrs: { uid: crypto.randomUUID() },
          content: [
            {
              type: "gqlurl",
              attrs: { uid: crypto.randomUUID() },
              content: [{ type: "text", text: url }],
            },
            {
              type: "gqlbody",
              attrs: {
                uid: crypto.randomUUID(),
                body: query,
                operationType: detectGraphqlOperationType(query),
                schemaUrl: null,
                schemaFileName: null,
                schemaFilePath: null,
              },
            },
          ],
        });
        if (body.graphql!.variables) {
          const vars = (body.graphql!.variables as string).replace(/\r\n/g, "\n");
          blocks.push({
            type: "gqlvariables",
            attrs: { uid: crypto.randomUUID(), body: vars },
          });
        }
      }
    }

    // 5. Post-response (test) scripts — imported commented-out (see buildScriptBlock)
    for (const event of data.event || []) {
      if (event.disabled || event.listen !== "test") continue;
      const scriptBlock = buildScriptBlock("post_script", event.script?.exec);
      if (scriptBlock) blocks.push(scriptBlock);
    }

    // Use helper to convert blocks to .void file format
    return helpers.convertBlocksToVoidFile(data.name, blocks);
  } catch (error) {
    const method = data.request?.method ?? 'UNKNOWN';
    const url = typeof data.request?.url === 'string' ? data.request.url : data.request?.url?.raw ?? 'unknown url';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to convert "${data.name}" (${method} ${url}): ${detail}`);
  }
};

// Matches the app's own save path (apps/ui useFileSystem.ts writeFileChunked) —
// writing a large file in one IPC call can freeze the Electron main process,
// so anything over this size is streamed in chunks instead.
const WRITE_CHUNK_SIZE = 512 * 1024;

async function writeFileChunked(filePath: string, content: string): Promise<void> {
  const files = (window as any).electron?.files;
  if (content.length <= WRITE_CHUNK_SIZE) {
    await files?.write(filePath, content);
    return;
  }
  for (let i = 0; i < content.length; i += WRITE_CHUNK_SIZE) {
    const chunk = content.slice(i, i + WRITE_CHUNK_SIZE);
    const isFirst = i === 0;
    const isLast = i + WRITE_CHUNK_SIZE >= content.length;
    await files?.appendChunk(filePath, chunk, isFirst, isLast);
  }
}

/**
 * Create a single .void file from a Postman request
 * Uses createVoid API to handle duplicate file names properly
 */
export const createSingleFile = async (request: PostmanRequest, currentPath: string, fileName: string) => {
  let content = await convertPostmanRequestToVoidenSchema(request);
  // Insert the request-level description as markdown documentation right
  // after the title heading, before the void blocks — appending it at the
  // end of the file left it detached from (and sometimes glued onto) the
  // last block's closing fence.
  const description = extractDescriptionText(request.request.description);
  if (description) {
    content = content.replace(/(# .+\n\n)/, (heading) => `${heading}${description}\n\n`);
  }
  // Use createVoid to handle deduplication (adds " 1", " 2", etc. if file exists)
  const result = await (window as any).electron?.files?.createVoid(currentPath, fileName);

  if (result?.path) {
    // Write content to the created file, chunked if it's large
    await writeFileChunked(result.path, content);
  }
};

/**
 * Count total items (requests) in a collection for progress tracking
 */
export const countTotalItems = (items: PostmanItem[]): number => {
  let total = 0;

  for (const item of items) {
    if (isPostmanFolder(item)) {
      // Add folder contents recursively
      total += countTotalItems(item.item);
    } else {
      // Count single file
      total += 1;
    }
  }

  return total;
};

/**
 * Process items recursively, creating folders and files
 */
export const processItems = async (
  items: PostmanItem[],
  currentPath: string,
  onProgress?: (current: number, total: number) => void,
  progressState = { current: 0, total: 0 },
  onError?: (itemName: string, error: unknown) => void,
  signal?: { cancelled: boolean },
) => {
  for (let i = 0; i < items.length; i++) {
    if (signal?.cancelled) return;

    const item = items[i];

    try {
      if (isPostmanFolder(item)) {
        const folderName = sanitizeName(item.name);

        // createDirectory returns the actual folder name (might be "folder-1", "folder-2" if duplicates)
        const actualFolderName = await (window as any).electron?.files?.createDirectory(currentPath, folderName);
        const folderPath = `${currentPath}/${actualFolderName}`;

        // Pass the same progressState object to nested calls
        await processItems(item.item, folderPath, onProgress, progressState, onError, signal);
      } else if (item.request) {
        try {
          await createSingleFile(item, currentPath, sanitizeName(item.name));
        } catch (error) {
          onError?.(item.name, error);
          progressState.current += 1;
          onProgress?.(progressState.current, progressState.total);
          continue;
        }

        // Increment progress counter
        progressState.current += 1;
        onProgress?.(progressState.current, progressState.total);
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      throw error;
    }
  }
};

/**
 * Import a Postman environment or globals export as project environment variables
 * @param env - Parsed Postman environment/globals export
 */
export const importPostmanEnvironment = async (env: PostmanEnvironmentExport) => {
  const variables = (env.values || [])
    .filter((v) => v.enabled !== false)
    .map((v) => ({ key: v.key, value: v.value }));

  if (variables.length > 0) {
    const envName = env.name || "Postman";
    //@ts-ignore
    await (window as any).electron?.env?.extendEnvs(`${envName} environment`, variables, envName);
  }

  return {
    success: true,
    message: variables.length > 0
      ? `Imported ${variables.length} environment variable(s)`
      : "No enabled variables found to import",
  };
};

/**
 * Main function to import a Postman collection
 * @param collection - JSON string of the Postman collection
 * @param activeProject - Path to the active project directory
 * @param onProgress - Optional callback for progress updates
 */
export const importPostmanCollection = async (
  collection: string,
  activeProject: string,
  onProgress?: (current: number, total: number) => void,
  onError?: (itemName: string, error: unknown) => void,
  signal?: { cancelled: boolean },
) => {
  try {
    const json: PostmanCollection | PostmanEnvironmentExport = JSON.parse(collection);

    if (!activeProject) {
      throw new Error("No active project found");
    }

    if (isPostmanEnvironmentExport(json)) {
      const result = await importPostmanEnvironment(json);
      onProgress?.(1, 1);
      return result;
    }

    // Count total items first
    const totalItems = countTotalItems(json.item);

    // Create progress state object
    const progressState = { current: 0, total: totalItems };

    // Create root collection folder
    const rootFolderName = sanitizeName(json.info.name);
    const actualRootFolderName = await (window as any).electron?.files?.createDirectory(activeProject, rootFolderName);
    // Create root void file for collection documentation
    const collectionDescription = extractDescriptionText(json.info.description);
    if (collectionDescription) {
      const result = await (window as any).electron?.files?.createVoid(`${activeProject}/${actualRootFolderName}`, rootFolderName);
      if (result?.path) {
        // createVoid creates an empty file — wrap the description in the same
        // frontmatter + title shape every other generated .void file gets,
        // rather than writing raw text with no frontmatter (which the editor
        // doesn't recognize as a well-formed .void document).
        const helpers = getVoidenApiHelpers();
        let content = helpers.convertBlocksToVoidFile(rootFolderName, []);
        content = content.replace(/(# .+\n\n)/, (heading) => `${heading}${collectionDescription}\n\n`);
        await writeFileChunked(result.path, content);
      }
    }
    if (json && json.variable && json.variable.length > 0) {
      //@ts-ignore
      await (window as any).electron?.env?.extendEnvs(`${rootFolderName} collection variables`, json.variable);
    }

    // Process items with global progress tracking
    await processItems(json.item, `${activeProject}/${actualRootFolderName}`, onProgress, progressState, onError, signal);

    return {
      success: true,
      message: "Collection imported successfully",
    };
  } catch (error) {
    throw error;
  }
};
