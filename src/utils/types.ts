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
  event?: {
    listen: string;
    script: {
      exec: string[];
      type: string;
      packages: Record<string, string>;
    };
  }[];
}

export interface PostmanRequestDetail {
  method: string;
  header: PostmanHeader[];
  body?: PostmanRequestBody;
  url: PostmanUrl | string; // Support both v2.0.0 (string) and v2.1.0 (object)
  auth?: PostmanAuth;
  description?:string
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
  options?: {
    raw?: {
      language?: string;
    };
  };
}

export interface PostmanFormParam {
  key: string;
  value: string;
  type?: string;
  disabled?: boolean;
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

export interface PostmanAuth {
  type: string;
  basic?: {
    username: string;
    password: string;
  };
  bearer?: {
    token: string;
  };
  apikey?: {
    key: string;
    value: string;
  };
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
 * Convert Postman's colon-style path segments (:id) to Voiden's brace-style
 * placeholders ({id}), e.g. "{{base_url}}/:id/:bye" -> "{{base_url}}/{id}/{bye}"
 */
export function convertColonPathParams(url: string): string {
  return url.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
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
  const matches = raw ? raw.match(/:([a-zA-Z0-9_]+)/g) : null;
  return matches ? matches.map((m) => [m.slice(1), ''] as [string, string]) : [];
}
