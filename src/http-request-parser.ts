import * as vscode from 'vscode';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface MappingAnnotation {
  name: string;
  startLine: number;
  endLine: number;
  rawText: string;
}

export interface MethodParam {
  raw: string;
  name: string;
  type: string;
  source: 'body' | 'query' | 'path' | 'header' | 'unknown';
  externalName?: string;
}

export interface MethodSignature {
  methodName: string;
  params: MethodParam[];
}

interface AnnotationRequestInfo {
  method: HttpMethod;
  path: string;
  contentType: string;
}

export function collectMappingAnnotations(document: vscode.TextDocument): MappingAnnotation[] {
  const text = document.getText();
  const regex = /@(PostMapping|GetMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(\(([\s\S]*?)\))?/g;
  const annotations: MappingAnnotation[] = [];

  for (const match of text.matchAll(regex)) {
    if (match.index === undefined) {
      continue;
    }
    const start = document.positionAt(match.index);
    const end = document.positionAt(match.index + match[0].length);
    annotations.push({
      name: match[1],
      startLine: start.line,
      endLine: end.line,
      rawText: match[0]
    });
  }
  return annotations;
}

export function parseMethodSignatureAfter(
  document: vscode.TextDocument,
  annotationEndLine: number
): MethodSignature | undefined {
  let line = annotationEndLine + 1;
  while (line < document.lineCount) {
    const text = document.lineAt(line).text.trim();
    if (!text) {
      line += 1;
      continue;
    }
    if (text.startsWith('@')) {
      line += 1;
      continue;
    }
    break;
  }

  if (line >= document.lineCount) {
    return undefined;
  }

  let signatureBuffer = '';
  let cursor = line;
  const maxLines = Math.min(document.lineCount, line + 30);
  while (cursor < maxLines) {
    const raw = document.lineAt(cursor).text;
    signatureBuffer += `${raw} `;
    if (raw.includes('{') || raw.includes(';')) {
      break;
    }
    cursor += 1;
  }

  const normalized = signatureBuffer.replace(/\s+/g, ' ').trim();
  const methodMatch = normalized.match(
    /(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?[\w<>\[\],.? ]+\s+(\w+)\s*\((.*)\)\s*(?:throws\s+[\w.,\s]+)?(?:\{|;)/
  );
  if (!methodMatch) {
    return undefined;
  }

  const methodName = methodMatch[1];
  const paramsText = methodMatch[2].trim();
  const params = paramsText
    ? splitJavaParameters(paramsText)
        .map((part) => parseMethodParam(part))
        .filter((item): item is MethodParam => !!item)
    : [];

  return {
    methodName,
    params
  };
}

export function parseClassName(document: vscode.TextDocument): string | undefined {
  const match = document.getText().match(/\bclass\s+(\w+)\b/);
  return match?.[1];
}

export function parseClassBasePath(document: vscode.TextDocument): string {
  const text = document.getText();
  const classMatch = text.match(/\bclass\s+\w+\b/);
  if (!classMatch || classMatch.index === undefined) {
    return '';
  }
  const beforeClass = text.slice(0, classMatch.index);
  const requestMappingMatches = [...beforeClass.matchAll(/@RequestMapping\s*(\(([\s\S]*?)\))?/g)];
  const lastRequestMapping = requestMappingMatches.at(-1);
  if (!lastRequestMapping) {
    return '';
  }
  const annotation = lastRequestMapping[0];
  const parsed = parseRequestInfoFromAnnotation(annotation);
  return parsed.path;
}

export function parseRequestInfoFromAnnotation(annotation: string): {
  method: HttpMethod;
  path: string;
  contentType: string;
} {
  const annotationName = annotation.match(/@(\w+)/)?.[1] ?? 'RequestMapping';
  const args = annotation.match(/\(([\s\S]*?)\)$/)?.[1]?.trim() ?? '';
  const requestMethod = parseHttpMethod(annotationName, args);
  const requestPath = parseMappingPath(args);
  const contentType = parseContentType(args);

  return {
    method: requestMethod,
    path: requestPath,
    contentType
  };
}

export function joinUrlPath(basePath: string, methodPath: string): string {
  const left = normalizePathPart(basePath);
  const right = normalizePathPart(methodPath);
  if (!left && !right) return '/';
  if (!left) return `/${right}`;
  if (!right) return `/${left}`;
  return `/${left}/${right}`;
}

function splitJavaParameters(paramsText: string): string[] {
  const items: string[] = [];
  let current = '';
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: '"' | "'" | '' = '';

  for (const ch of paramsText) {
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : (ch as '"' | "'");
      current += ch;
      continue;
    }
    if (quote) {
      current += ch;
      continue;
    }

    if (ch === '<') angleDepth += 1;
    if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (
      ch === ',' &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      const trimmed = current.trim();
      if (trimmed) {
        items.push(trimmed);
      }
      current = '';
      continue;
    }
    current += ch;
  }

  const last = current.trim();
  if (last) {
    items.push(last);
  }
  return items;
}

function parseMethodParam(param: string): MethodParam | undefined {
  const source = detectParamSource(param);
  const externalName = extractAnnotationNameOverride(param);
  const cleaned = param
    .replace(/@\w+(\s*\([^()]*\))?/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const match = cleaned.match(/(.+)\s+(\w+)$/);
  if (!match) {
    return undefined;
  }

  return {
    raw: param,
    type: match[1].trim(),
    name: match[2].trim(),
    source,
    externalName
  };
}

function detectParamSource(rawParam: string): MethodParam['source'] {
  if (/@RequestBody\b/.test(rawParam)) return 'body';
  if (/@PathVariable\b/.test(rawParam)) return 'path';
  if (/@RequestParam\b/.test(rawParam)) return 'query';
  if (/@RequestHeader\b/.test(rawParam)) return 'header';
  return 'unknown';
}

function extractAnnotationNameOverride(rawParam: string): string | undefined {
  const named = rawParam.match(/@(RequestParam|PathVariable)\s*\(([\s\S]*?)\)/);
  if (!named) {
    return undefined;
  }
  const args = named[2];
  const valueExpr = extractNamedAttribute(args, 'value') ?? extractNamedAttribute(args, 'name');
  return stripQuotes(extractFirstStringLiteral(valueExpr ?? args) ?? '');
}

function parseHttpMethod(annotationName: string, args: string): HttpMethod {
  const byName: Record<string, HttpMethod> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    DeleteMapping: 'DELETE',
    PatchMapping: 'PATCH'
  };
  if (annotationName in byName) {
    return byName[annotationName];
  }

  const methodExpr = extractNamedAttribute(args, 'method');
  const methodMatch = methodExpr?.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i);
  if (methodMatch) {
    return methodMatch[1].toUpperCase() as HttpMethod;
  }
  return 'GET';
}

function parseMappingPath(args: string): string {
  if (!args) {
    return '';
  }
  const namedPath = extractNamedAttribute(args, 'value') ?? extractNamedAttribute(args, 'path');
  if (namedPath) {
    const first = extractFirstStringLiteral(namedPath);
    return first ? stripQuotes(first) : '';
  }

  const shorthand = extractFirstStringLiteral(args);
  return shorthand ? stripQuotes(shorthand) : '';
}

function parseContentType(args: string): string {
  const consumesExpr = extractNamedAttribute(args, 'consumes');
  if (consumesExpr) {
    return normalizeMediaType(consumesExpr);
  }
  const headersExpr = extractNamedAttribute(args, 'headers');
  if (headersExpr) {
    const explicit = headersExpr.match(/Content-Type\s*=\s*["']?([^"',}]+)["']?/i);
    if (explicit?.[1]) {
      return explicit[1].trim();
    }
  }
  return 'application/json';
}

function extractNamedAttribute(args: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}\\s*=\\s*(\\{[^}]*\\}|\"[^\"]*\"|'[^']*'|[\\w.]+)`);
  const found = args.match(pattern);
  return found?.[1]?.trim();
}

function extractFirstStringLiteral(raw: string): string | undefined {
  const stringMatch = raw.match(/\"([^\"]*)\"|'([^']*)'/);
  if (!stringMatch) {
    return undefined;
  }
  return stringMatch[1] !== undefined ? `"${stringMatch[1]}"` : `'${stringMatch[2]}'`;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function normalizeMediaType(rawValue: string): string {
  if (/APPLICATION_JSON/i.test(rawValue)) return 'application/json';
  if (/APPLICATION_FORM_URLENCODED/i.test(rawValue)) return 'application/x-www-form-urlencoded';
  if (/MULTIPART_FORM_DATA/i.test(rawValue)) return 'multipart/form-data';
  if (/TEXT_PLAIN/i.test(rawValue)) return 'text/plain';

  const literal = extractFirstStringLiteral(rawValue);
  if (literal) {
    return stripQuotes(literal);
  }
  return 'application/json';
}

function normalizePathPart(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}
