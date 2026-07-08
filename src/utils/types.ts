/**
 * Postman Collection Types
 */

export interface PostmanCollection {
  info: PostmanInfo;
  item: PostmanItem[];
  variable:[{key:string,value:string}]
}

export interface PostmanInfo {
  _postman_id: string;
  name: string;
  schema: string;
  description?: string;
}

export type PostmanItem = PostmanFolder | PostmanRequest;

export interface PostmanFolder {
  name: string;
  item: PostmanItem[];
  description?: string;
}

export interface PostmanRequest {
  name: string;
  request: PostmanRequestDetail;
  event?: PostmanEvent[];
}

export interface PostmanEvent {
  listen: string; // "prerequest" | "test"
  disabled?: boolean;
  script: {
    exec: string[] | string;
    type?: string;
    packages?: Record<string, string>;
  };
}

export interface PostmanRequestDetail {
  method: string;
  header: PostmanHeader[];
  body?: PostmanRequestBody;
  url: PostmanUrl | string; // Support both v2.0.0 (string) and v2.1.0 (object)
  auth?: PostmanAuth;
  description?: string | { content: string; type?: string }; // Postman allows either shape
}

/**
 * Postman's `description` field can be a plain string or a
 * `{ content, type }` object — normalize to plain text either way.
 */
export function extractDescriptionText(description: string | { content: string; type?: string } | undefined): string {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return description.content ?? '';
}

export interface PostmanHeader {
  key: string;
  value: string;
  type: string;
  disabled?: boolean;
}

export interface PostmanRequestBody {
  mode: string;
  raw?: string;
  formdata?: PostmanFormParam[];
  urlencoded?: PostmanFormParam[];
  graphql?: PostmanGraphqlBody;
  options?: {
    raw?: {
      language?: string;
    };
  };
}

export interface PostmanFormParam {
  key: string;
  value?: string;
  type?: 'text' | 'file';
  src?: string | string[] | null; // present when type === 'file'
  disabled?: boolean;
}

export interface PostmanGraphqlBody {
  query: string;
  variables?: string; // JSON-encoded string, as stored by Postman
}

export interface PostmanUrl {
  raw: string;
  protocol: string;
  host: string[];
  port?: string;
  path: string[];
  query?: PostmanQueryParameter[];
  variable?: PostmanPathVariable[];
}

export interface PostmanQueryParameter {
  key: string;
  value: string;
  disabled?: boolean;
}

export interface PostmanPathVariable {
  key: string;
  value: string;
  disabled?: boolean;
}

/**
 * Postman environment / globals export file
 * (the JSON produced by Postman's "Export" action on an environment or globals)
 */
export interface PostmanEnvironmentExport {
  id: string;
  name: string;
  values: PostmanEnvironmentValue[];
  _postman_variable_scope: 'environment' | 'globals';
}

export interface PostmanEnvironmentValue {
  key: string;
  value: string;
  type?: string;
  enabled?: boolean;
}

export function isPostmanEnvironmentExport(json: any): json is PostmanEnvironmentExport {
  return json?._postman_variable_scope === 'environment' || json?._postman_variable_scope === 'globals';
}

/**
 * Postman represents every auth sub-config (basic, bearer, apikey, oauth2, ...)
 * as an array of {key, value} pairs — not a fixed-shape object.
 * e.g. auth.basic = [{key:"username", value:"u"}, {key:"password", value:"p"}]
 */
export interface PostmanAuthParam {
  key: string;
  value?: any;
  type?: string;
}

export interface PostmanAuth {
  type: string; // noauth | basic | bearer | apikey | oauth2 | oauth1 | digest | ntlm | awsv4 | hawk | edgegrid
  noauth?: any;
  basic?: PostmanAuthParam[];
  bearer?: PostmanAuthParam[];
  apikey?: PostmanAuthParam[];
  oauth2?: PostmanAuthParam[];
  oauth1?: PostmanAuthParam[];
  digest?: PostmanAuthParam[];
  ntlm?: PostmanAuthParam[];
  awsv4?: PostmanAuthParam[];
  hawk?: PostmanAuthParam[];
}

/**
 * Read a named field out of a Postman auth sub-config. Handles the real
 * array-of-{key,value} shape, and tolerates a flat object as a fallback
 * in case of hand-edited or non-standard collection files.
 */
export function getAuthParam(source: PostmanAuthParam[] | Record<string, any> | undefined, key: string): string | undefined {
  if (!source) return undefined;
  if (Array.isArray(source)) {
    const found = source.find((p) => p?.key === key);
    return found?.value !== undefined && found?.value !== null ? String(found.value) : undefined;
  }
  if (typeof source === 'object' && source[key] !== undefined && source[key] !== null) {
    return String(source[key]);
  }
  return undefined;
}

export function isPostmanFolder(item: PostmanItem): item is PostmanFolder {
  return (item as PostmanFolder).item !== undefined;
}

/**
 * Normalize URL to always return a string
 * Handles both v2.0.0 (string) and v2.1.0 (object) formats
 */
export function normalizePostmanUrl(url: PostmanUrl | string): string {
  if (typeof url === 'string') {
    return url;
  }
  return url.raw;
}

/**
 * Splits a URL into its authority (scheme://host:port) and the remainder
 * (path/query/hash), so path-param scanning never touches a literal port
 * number like the "3000" in "http://localhost:3000/api/:id".
 */
function splitUrlAuthority(url: string): { authority: string; rest: string } {
  const match = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/);
  if (!match) return { authority: '', rest: url };
  return { authority: match[0], rest: url.slice(match[0].length) };
}

/**
 * Convert Postman's colon-style path segments (:id) to Voiden's brace-style
 * placeholders ({id}), e.g. "{{base_url}}/:id/:bye" -> "{{base_url}}/{id}/{bye}"
 */
export function convertColonPathParams(url: string): string {
  const { authority, rest } = splitUrlAuthority(url);
  return authority + rest.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

/**
 * Extract path parameters from a Postman URL.
 * Prefers the explicit `variable` array (Postman v2.1 path variables);
 * falls back to inferring `:name` segments from the raw URL when absent.
 */
export function extractPostmanPathParams(url: PostmanUrl | string): Array<[string, string]> {
  if (typeof url === 'object' && url.variable && url.variable.length > 0) {
    return url.variable
      .filter((v) => !v.disabled)
      .map((v) => [v.key, v.value ?? ''] as [string, string]);
  }

  const raw = typeof url === 'string' ? url : url.raw;
  if (!raw) return [];
  const { rest } = splitUrlAuthority(raw);
  const matches = rest.match(/:([a-zA-Z0-9_]+)/g);
  return matches ? matches.map((m) => [m.slice(1), ''] as [string, string]) : [];
}
