import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

// 文件作用: 采集 Controller -> Service -> Mapper -> SQL 的业务上下文，供请求体 AI 生成阶段复用。
const EXCLUDE_GLOB = '**/{target,build,out,node_modules,.git,dist}/**';
const DEFAULT_SQL_SEARCH_GLOBS = [
  '**/src/main/resources/sql/**/*.{md,sql,xml}',
  '**/src/main/resources/**/*Mapper.xml',
  '**/*.{md,sql,xml}'
];
const CONTEXT_CACHE_LIMIT = 200;
const CONTEXT_CACHE = new Map<string, ContextAgentResult>();
const SQL_CANDIDATE_CACHE = new Map<string, vscode.Uri[]>();

type ContextLogLevel = 'INFO' | 'STEP' | 'ERROR';
type ContextLogger = (level: ContextLogLevel, message: string) => void;

interface ContextAgentOptions {
  document: vscode.TextDocument;
  methodName: string;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  reactSystemPrompt?: string;
  sqlSearchGlobs?: string[];
  logger?: ContextLogger;
}

interface ContextAgentResult {
  contextText: string;
  summary: string;
}

interface InjectionInfo {
  name: string;
  type: string;
  inject_mode: 'field' | 'constructor' | 'other';
}

interface MemberCallInfo {
  owner: string;
  method: string;
  expression: string;
  index: number;
}

interface MethodSnippetInfo {
  snippet: string;
  startOffset: number;
  endOffset: number;
  signature: string;
}

export async function collectProjectContextForPrompt(
  options: ContextAgentOptions
): Promise<ContextAgentResult> {
  const { document, methodName, sqlSearchGlobs = DEFAULT_SQL_SEARCH_GLOBS, logger } =
    options || ({} as ContextAgentOptions);

  const logStep = (message: string): void => {
    logger?.('STEP', `[本地上下文] ${message}`);
  };
  const logError = (message: string): void => {
    logger?.('ERROR', `[本地上下文] ${message}`);
  };

  if (!document || !methodName) {
    return {
      contextText: '',
      summary: '缺少 document 或 methodName，未采集业务上下文'
    };
  }

  try {
    const controllerText = await readSourceFileByPath(document.uri.fsPath);
    const cacheKey = buildContextCacheKey(document.uri.fsPath, methodName, controllerText);
    const cached = CONTEXT_CACHE.get(cacheKey);
    if (cached) {
      // 关键逻辑: 相同文件内容与方法名直接复用上下文，避免重复链路解析。
      logStep(`命中上下文缓存: method=${methodName}`);
      return cached;
    }

    const currentDir = path.dirname(document.uri.fsPath).toLowerCase();
    const methodInfo = extractJavaMethodSnippet(controllerText, methodName);
    if (!methodInfo) {
      const result = {
        contextText: `[AI上下文]\n未定位到目标方法实现。\n目标方法: ${methodName}`,
        summary: '未定位到目标方法实现'
      };
      setContextCache(cacheKey, result);
      return result;
    }

    logStep(`开始本地链路解析: method=${methodName}, file=${document.fileName}`);
    const controllerImports = parseImports(controllerText);
    logStep(`Controller源码: ${controllerText}`);
    const controllerInjections = parseInjectedFields(controllerText, controllerImports);
    let serviceCallOffsetBase = methodInfo.startOffset;
    let serviceCandidates = pickServiceCalls(methodInfo.snippet, controllerInjections, controllerImports);
    if (serviceCandidates.length === 0) {
      // 关键逻辑: 目标方法片段未命中时回退 Controller 全文扫描，避免因局部代码导致 Service 线索丢失。
      logStep('目标方法片段未命中 Service 调用，回退到 Controller 全文扫描');
      serviceCandidates = pickServiceCalls(controllerText, controllerInjections, controllerImports);
      serviceCallOffsetBase = 0;
    }
    if (serviceCandidates.length === 0) {
      const result = {
        contextText: `[AI上下文]\nController 未识别到 Service 调用。\n目标方法: ${methodName}`,
        summary: '未识别 Service 调用'
      };
      setContextCache(cacheKey, result);
      return result;
    }

    const primaryServiceCall = serviceCandidates[0];
    const serviceType = baseJavaTypeName(primaryServiceCall.type);
    const serviceCallOffset = serviceCallOffsetBase + primaryServiceCall.call.index;
    logStep(`命中 Service 调用: var=${primaryServiceCall.call.owner}, type=${serviceType}, method=${primaryServiceCall.call.method}`);

    const serviceImport = controllerImports[serviceType];
    // 关键逻辑: 路径解析优先级为“定义跳转 -> import 精确匹配 -> 全局检索兜底”。
    let serviceFile =
      (await resolveTypeFileByDefinition(document, serviceCallOffset, serviceType)) ||
      (await findServiceImplFile(serviceType, serviceImport, document, 240)) ||
      (await findJavaTypeFile(serviceType, document, serviceImport, 140));

    if (!serviceFile) {
      const result = {
        contextText: `[AI上下文]\n未找到 Service 文件。\n类型: ${serviceType}`,
        summary: '未找到 Service 文件'
      };
      setContextCache(cacheKey, result);
      return result;
    }

    let serviceText = await fs.readFile(serviceFile.fsPath, 'utf8');
    let serviceMethodInfo = extractJavaMethodSnippet(serviceText, primaryServiceCall.call.method);
    if (!serviceMethodInfo && !/Impl\.java$/i.test(serviceFile.fsPath)) {
      const implFile = await findServiceImplFile(serviceType, serviceImport, document, 240);
      if (implFile && normalizePath(implFile.fsPath) !== normalizePath(serviceFile.fsPath)) {
        serviceFile = implFile;
        serviceText = await fs.readFile(serviceFile.fsPath, 'utf8');
        serviceMethodInfo = extractJavaMethodSnippet(serviceText, primaryServiceCall.call.method);
      }
    }
    logStep(`命中 Service 文件: ${serviceFile.fsPath}`);

    const serviceSnippet = serviceMethodInfo ? serviceMethodInfo.snippet : trimText(serviceText, 5000);
    const serviceSections = [
      [
        '[Service证据]',
        `类型: ${serviceType}`,
        `方法: ${primaryServiceCall.call.method}`,
        `文件: ${serviceFile.fsPath}`,
        trimText(serviceSnippet, 8000)
      ].join('\n')
    ];

    let sqlSections: string[] = [];
    if (serviceMethodInfo) {
      const serviceImports = parseImports(serviceText);
      const serviceInjections = parseInjectedFields(serviceText, serviceImports);
      const mapperCandidates = pickMapperCalls(serviceMethodInfo.snippet, serviceInjections, serviceImports);
      if (mapperCandidates.length > 0) {
        const primaryMapperCall = mapperCandidates[0];
        const mapperType = baseJavaTypeName(primaryMapperCall.type);
        const mapperCallOffset = serviceMethodInfo.startOffset + primaryMapperCall.call.index;
        logStep(`命中 Mapper 调用: var=${primaryMapperCall.call.owner}, type=${mapperType}, method=${primaryMapperCall.call.method}`);

        const serviceDocument = await vscode.workspace.openTextDocument(serviceFile);
        const mapperImport = serviceImports[mapperType];
        const mapperFile =
          (await resolveTypeFileByDefinition(serviceDocument, mapperCallOffset, mapperType)) ||
          (await findJavaTypeFile(mapperType, serviceDocument, mapperImport, 180));

        if (mapperFile) {
          const mapperText = await fs.readFile(mapperFile.fsPath, 'utf8');
          logStep(`命中 Mapper 文件: ${mapperFile.fsPath}`);
          const sqlResources = extractSqlResourceNames(mapperText, mapperType);
          const matched = await resolveSqlEvidence(
            sqlResources,
            currentDir,
            sqlSearchGlobs,
            primaryMapperCall.call.method
          );
          if (matched) {
            const sqlText = await fs.readFile(matched.file.fsPath, 'utf8');
            const sqlSnippet = extractSqlByMethod(sqlText, primaryMapperCall.call.method, matched.file.fsPath);
            sqlSections = [
              [
                '[SQL证据]',
                `资源名: ${matched.resource}`,
                `文件: ${matched.file.fsPath}`,
                `方法: ${primaryMapperCall.call.method}`,
                trimText(
                  sqlSnippet || `未在 SQL 资源中找到方法 ${primaryMapperCall.call.method} 的实现`,
                  9000
                )
              ].join('\n')
            ];
            logStep(`命中 SQL 文件: resource=${matched.resource}, file=${matched.file.fsPath}`);
          }
        }
      }
    }

    if (serviceSections.length === 0 && sqlSections.length === 0) {
      const result = {
        contextText: `[AI上下文]\n未找到可用 Service/SQL 证据。\n目标方法: ${methodName}`,
        summary: '未形成有效 Service/SQL 证据'
      };
      setContextCache(cacheKey, result);
      return result;
    }

    const contextText = trimText(
      [
        '[本地上下文采集结果]',
        `Controller文件: ${document.fileName}`,
        `目标方法: ${methodName}`,
        serviceSections.join('\n\n'),
        sqlSections.join('\n\n')
      ]
        .filter((item) => item)
        .join('\n\n'),
      26000
    );
    const result = {
      contextText,
      summary: `Service证据 ${serviceSections.length} 段, SQL证据 ${sqlSections.length} 段`
    };
    setContextCache(cacheKey, result);
    logStep(`本地链路解析结束: ${result.summary}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
    logError(`上下文采集失败: ${message}`);
    return {
      contextText: `[业务上下文采集失败]\n${message}`,
      summary: `上下文采集失败: ${message}`
    };
  }
}

function buildContextCacheKey(filePath: string, methodName: string, text: string): string {
  const normalizedPath = normalizePath(filePath);
  const textHash = hashText(text);
  return `${normalizedPath}::${methodName}::${textHash}`;
}

async function readSourceFileByPath(filePath: string): Promise<string> {
  if (!filePath) {
    throw new Error('源码路径为空，无法读取 Controller 源码');
  }
  return fs.readFile(filePath, 'utf8');
}

function setContextCache(key: string, value: ContextAgentResult): void {
  if (CONTEXT_CACHE.size >= CONTEXT_CACHE_LIMIT) {
    const oldestKey = CONTEXT_CACHE.keys().next().value as string | undefined;
    if (oldestKey) {
      CONTEXT_CACHE.delete(oldestKey);
    }
  }
  CONTEXT_CACHE.set(key, value);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function extractJavaMethodSnippet(javaText: string, methodName: string): MethodSnippetInfo | undefined {
  if (!javaText || !methodName) {
    return undefined;
  }
  const methodRegex = new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`, 'g');
  let match = methodRegex.exec(javaText);
  while (match) {
    const methodNameIndex = match.index;
    const charBefore = findPreviousNonWhitespaceChar(javaText, methodNameIndex - 1);
    if (charBefore === '.') {
      match = methodRegex.exec(javaText);
      continue;
    }

    const openParenIndex = javaText.indexOf('(', methodNameIndex);
    if (openParenIndex < 0) {
      match = methodRegex.exec(javaText);
      continue;
    }
    const closeParenIndex = findMatchingPair(javaText, openParenIndex, '(', ')');
    if (closeParenIndex < 0) {
      match = methodRegex.exec(javaText);
      continue;
    }

    let cursor = closeParenIndex + 1;
    while (cursor < javaText.length && /\s/.test(javaText[cursor])) {
      cursor += 1;
    }
    while (cursor < javaText.length && javaText.startsWith('throws', cursor)) {
      cursor += 'throws'.length;
      while (cursor < javaText.length && javaText[cursor] !== '{' && javaText[cursor] !== ';') {
        cursor += 1;
      }
    }

    if (javaText[cursor] !== '{') {
      match = methodRegex.exec(javaText);
      continue;
    }
    const methodBodyEnd = findMatchingPair(javaText, cursor, '{', '}');
    if (methodBodyEnd < 0) {
      match = methodRegex.exec(javaText);
      continue;
    }

    let methodStart = findLineStart(javaText, methodNameIndex);
    methodStart = includeAnnotationLines(javaText, methodStart);
    const snippet = javaText.slice(methodStart, methodBodyEnd + 1).trim();
    const signature = javaText.slice(methodStart, cursor).trim();
    return {
      snippet,
      startOffset: methodStart,
      endOffset: methodBodyEnd + 1,
      signature
    };
  }
  return undefined;
}

function findPreviousNonWhitespaceChar(text: string, startIndex: number): string {
  for (let i = startIndex; i >= 0; i -= 1) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return '';
}

function findMatchingPair(text: string, startIndex: number, left: string, right: string): number {
  let depth = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === left) {
      depth += 1;
      continue;
    }
    if (ch === right) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findLineStart(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  const start = text.lastIndexOf('\n', index);
  return start === -1 ? 0 : start + 1;
}

function includeAnnotationLines(text: string, methodStart: number): number {
  let currentStart = methodStart;
  while (currentStart > 0) {
    let prevLineEnd = currentStart - 1;
    if (prevLineEnd >= 0 && text[prevLineEnd] === '\n') {
      prevLineEnd -= 1;
    }
    if (prevLineEnd < 0) {
      break;
    }
    const prevLineStart = findLineStart(text, prevLineEnd);
    if (prevLineStart >= currentStart) {
      break;
    }
    const prevLine = text.slice(prevLineStart, prevLineEnd + 1).trim();
    if (!prevLine || prevLine.startsWith('@')) {
      currentStart = prevLineStart;
      continue;
    }
    break;
  }
  return currentStart;
}

function parseImports(javaText: string): Record<string, string> {
  const imports: Record<string, string> = {};
  const regex = /^\s*import\s+([a-zA-Z0-9_.]+)\s*;/gm;
  let match = regex.exec(javaText);
  while (match) {
    const full = match[1].trim();
    const simple = full.split('.').at(-1);
    if (simple) {
      imports[simple] = full;
    }
    match = regex.exec(javaText);
  }
  return imports;
}

function parseInjectedFields(javaText: string, imports: Record<string, string>): InjectionInfo[] {
  const constructorInjections = parseConstructorInjectedFields(javaText);
  const hasRequiredArgsConstructor = /@RequiredArgsConstructor\b/.test(javaText);
  const classBodyRange = findPrimaryClassBodyRange(javaText);
  const regex =
    /^\s*(?:(?:private|protected|public)\s+)?(?:(?:final|transient|volatile)\s+)*(?!static\b)([A-Za-z0-9_<>\[\].?, $]+)\s+([A-Za-z0-9_]+)\s*(?:=[^;]*)?;/gm;

  const result: InjectionInfo[] = [];
  const dedupe = new Set<string>();
  let match = regex.exec(javaText);
  while (match) {
    if (!classBodyRange || !isTopLevelClassMemberPosition(javaText, match.index, classBodyRange)) {
      match = regex.exec(javaText);
      continue;
    }
    const fullType = String(match[1] || '').trim();
    const name = String(match[2] || '').trim();
    if (!fullType || !name) {
      match = regex.exec(javaText);
      continue;
    }
    const lineStart = findLineStart(javaText, match.index);
    const lineEnd = javaText.indexOf('\n', match.index);
    const lineText = javaText.slice(lineStart, lineEnd === -1 ? javaText.length : lineEnd);
    const annotationBlock = findFieldAnnotationBlock(javaText, lineStart);
    const hasFieldInjectAnnotation = /@(Autowired|Resource|Inject)\b/.test(`${annotationBlock}\n${lineText}`);
    const isFinal = /\bfinal\b/.test(lineText);
    const constructorType = constructorInjections.get(name);
    const type = constructorType || fullType;
    const injectMode: InjectionInfo['inject_mode'] = constructorType
      ? 'constructor'
      : hasFieldInjectAnnotation || (hasRequiredArgsConstructor && isFinal)
        ? 'field'
        : 'other';

    if (injectMode === 'other' && !isLikelyComponentType(type, imports)) {
      match = regex.exec(javaText);
      continue;
    }
    const key = `${name}::${type}`;
    if (!dedupe.has(key)) {
      dedupe.add(key);
      result.push({ name, type, inject_mode: injectMode });
    }
    match = regex.exec(javaText);
  }

  for (const [name, type] of constructorInjections.entries()) {
    const key = `${name}::${type}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    result.push({ name, type, inject_mode: 'constructor' });
  }
  return result;
}

function findPrimaryClassBodyRange(javaText: string): { start: number; end: number } | undefined {
  const classMatch = /\bclass\s+[A-Za-z0-9_]+\b[^{]*\{/m.exec(javaText);
  if (!classMatch || classMatch.index === undefined) {
    return undefined;
  }
  const openBraceOffset = classMatch[0].lastIndexOf('{');
  if (openBraceOffset < 0) {
    return undefined;
  }
  const start = classMatch.index + openBraceOffset;
  const end = findMatchingPair(javaText, start, '{', '}');
  if (end < 0) {
    return undefined;
  }
  return { start, end };
}

// 关键逻辑: 仅在类顶层(depth=1)解析字段，避免把方法体里的局部变量误判为注入成员。
function isTopLevelClassMemberPosition(
  javaText: string,
  index: number,
  range: { start: number; end: number }
): boolean {
  if (index <= range.start || index >= range.end) {
    return false;
  }
  let depth = 1;
  let quote: '"' | "'" | '' = '';
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = range.start + 1; i < index; i += 1) {
    const ch = javaText[i];
    const next = javaText[i + 1] || '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!quote && ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (!quote && ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if ((ch === '"' || ch === "'") && javaText[i - 1] !== '\\') {
      if (!quote) {
        quote = ch as '"' | "'";
      } else if (quote === ch) {
        quote = '';
      }
      continue;
    }
    if (quote) {
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth === 1;
}

function findFieldAnnotationBlock(javaText: string, lineStart: number): string {
  const lines: string[] = [];
  let cursor = lineStart;
  while (cursor > 0) {
    let prevLineEnd = cursor - 1;
    if (prevLineEnd >= 0 && javaText[prevLineEnd] === '\n') {
      prevLineEnd -= 1;
    }
    if (prevLineEnd < 0) {
      break;
    }
    const prevLineStart = findLineStart(javaText, prevLineEnd);
    if (prevLineStart >= cursor) {
      break;
    }
    const prevLine = javaText.slice(prevLineStart, prevLineEnd + 1).trim();
    if (!prevLine) {
      cursor = prevLineStart;
      continue;
    }
    if (prevLine.startsWith('@')) {
      lines.unshift(prevLine);
      cursor = prevLineStart;
      continue;
    }
    break;
  }
  return lines.join('\n');
}

function parseConstructorInjectedFields(javaText: string): Map<string, string> {
  const result = new Map<string, string>();
  const className = parseClassName(javaText);
  if (!className) {
    return result;
  }

  const ctorRegex = new RegExp(`\\b${escapeRegExp(className)}\\s*\\(`, 'g');
  let ctorMatch = ctorRegex.exec(javaText);
  while (ctorMatch) {
    const openParenIndex = javaText.indexOf('(', ctorMatch.index);
    if (openParenIndex < 0) {
      ctorMatch = ctorRegex.exec(javaText);
      continue;
    }
    const closeParenIndex = findMatchingPair(javaText, openParenIndex, '(', ')');
    if (closeParenIndex < 0) {
      ctorMatch = ctorRegex.exec(javaText);
      continue;
    }
    let braceStart = closeParenIndex + 1;
    while (braceStart < javaText.length && /\s/.test(javaText[braceStart])) {
      braceStart += 1;
    }
    if (javaText[braceStart] !== '{') {
      ctorMatch = ctorRegex.exec(javaText);
      continue;
    }
    const braceEnd = findMatchingPair(javaText, braceStart, '{', '}');
    if (braceEnd < 0) {
      ctorMatch = ctorRegex.exec(javaText);
      continue;
    }

    const paramsText = javaText.slice(openParenIndex + 1, closeParenIndex);
    const ctorBody = javaText.slice(braceStart + 1, braceEnd);
    const params = splitTopLevelComma(paramsText)
      .map((item) => parseJavaParameter(item))
      .filter((item): item is { type: string; name: string } => !!item);
    for (const param of params) {
      const assignmentRegex = new RegExp(
        `\\bthis\\s*\\.\\s*([A-Za-z0-9_]+)\\s*=\\s*${escapeRegExp(param.name)}\\s*;`
      );
      const assignment = assignmentRegex.exec(ctorBody);
      if (assignment?.[1]) {
        result.set(assignment[1], param.type);
      } else {
        result.set(param.name, param.type);
      }
    }
    ctorMatch = ctorRegex.exec(javaText);
  }
  return result;
}

function parseClassName(javaText: string): string {
  const match = javaText.match(/\bclass\s+([A-Za-z0-9_]+)\b/);
  return String(match?.[1] || '').trim();
}

function parseJavaParameter(param: string): { type: string; name: string } | undefined {
  const cleaned = param
    .replace(/@\w+(\s*\([^()]*\))?/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = cleaned.match(/(.+)\s+([A-Za-z0-9_]+)$/);
  if (!match) {
    return undefined;
  }
  return {
    type: match[1].trim(),
    name: match[2].trim()
  };
}

function splitTopLevelComma(text: string): string[] {
  const items: string[] = [];
  let current = '';
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: '"' | "'" | '' = '';
  for (const ch of text) {
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
    if (ch === ',' && angleDepth === 0 && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      const part = current.trim();
      if (part) {
        items.push(part);
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

function collectMemberCalls(methodSnippet: string): MemberCallInfo[] {
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const calls: MemberCallInfo[] = [];
  let match = regex.exec(methodSnippet);
  while (match) {
    const owner = String(match[1] || '').trim();
    const method = String(match[2] || '').trim();
    if (owner && method) {
      calls.push({
        owner,
        method,
        expression: `${owner}.${method}(...)`,
        index: match.index
      });
    }
    match = regex.exec(methodSnippet);
  }
  return calls;
}

function pickServiceCalls(
  methodSnippet: string,
  injections: InjectionInfo[],
  imports: Record<string, string>
): Array<{ call: MemberCallInfo; type: string }> {
  const typeByVar = new Map<string, string>();
  for (const item of injections) {
    typeByVar.set(item.name, item.type);
  }
  const candidates = collectMemberCalls(methodSnippet)
    .map((call) => ({ call, type: typeByVar.get(call.owner) || '' }))
    .filter((item) => item.type && isLikelyServiceType(item.type, imports));
  return candidates
    .slice()
    .sort((a, b) => scoreServiceCall(b.call, b.type, imports) - scoreServiceCall(a.call, a.type, imports));
}

function pickMapperCalls(
  serviceMethodSnippet: string,
  injections: InjectionInfo[],
  imports: Record<string, string>
): Array<{ call: MemberCallInfo; type: string }> {
  const typeByVar = new Map<string, string>();
  for (const item of injections) {
    typeByVar.set(item.name, item.type);
  }
  const candidates = collectMemberCalls(serviceMethodSnippet)
    .map((call) => ({ call, type: typeByVar.get(call.owner) || '' }))
    .filter((item) => item.type && isLikelyMapperType(item.type, imports));
  return candidates
    .slice()
    .sort((a, b) => scoreMapperCall(b.call, b.type, imports) - scoreMapperCall(a.call, a.type, imports));
}

function scoreServiceCall(call: MemberCallInfo, typeName: string, imports: Record<string, string>): number {
  const owner = call.owner.toLowerCase();
  const method = call.method.toLowerCase();
  let score = 0;
  if (isLikelyServiceType(typeName, imports)) score += 100;
  if (owner.includes('service') || owner.includes('biz') || owner.includes('manager')) score += 20;
  if (/^(query|get|list|find|search|page|save|create|update|delete)/.test(method)) score += 10;
  return score;
}

function scoreMapperCall(call: MemberCallInfo, typeName: string, imports: Record<string, string>): number {
  const owner = call.owner.toLowerCase();
  const method = call.method.toLowerCase();
  let score = 0;
  if (isLikelyMapperType(typeName, imports)) score += 100;
  if (owner.includes('mapper') || owner.includes('dao') || owner.includes('repo')) score += 20;
  if (/^(select|query|get|find|insert|save|update|delete)/.test(method)) score += 10;
  return score;
}

function isLikelyComponentType(typeName: string, imports: Record<string, string>): boolean {
  const simpleType = baseJavaTypeName(typeName);
  const importPath = imports[simpleType] || '';
  return /(service|mapper|dao|repository|manager|client|facade|gateway)/i.test(simpleType) ||
    /\.(service|mapper|dao|repository|manager|client|facade|gateway)\./i.test(importPath);
}

function isLikelyServiceType(typeName: string, imports: Record<string, string>): boolean {
  const simpleType = baseJavaTypeName(typeName);
  const importPath = imports[simpleType] || '';
  return /(service|biz|manager)/i.test(simpleType) || /\.(service|biz|manager)\./i.test(importPath);
}

function isLikelyMapperType(typeName: string, imports: Record<string, string>): boolean {
  const simpleType = baseJavaTypeName(typeName);
  const importPath = imports[simpleType] || '';
  return /(mapper|dao|repository)/i.test(simpleType) || /\.(mapper|dao|repository)\./i.test(importPath);
}

async function resolveTypeFileByDefinition(
  document: vscode.TextDocument,
  offset: number,
  expectedSimpleType: string
): Promise<vscode.Uri | undefined> {
  if (offset < 0) {
    return undefined;
  }
  const position = document.positionAt(offset);
  const definitions =
    (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      document.uri,
      position
    )) || [];
  if (!Array.isArray(definitions) || definitions.length === 0) {
    return undefined;
  }

  let best: { uri: vscode.Uri; score: number } | undefined;
  for (const item of definitions) {
    const uri = toDefinitionUri(item);
    if (!uri || path.extname(uri.fsPath).toLowerCase() !== '.java') {
      continue;
    }
    const fileName = path.parse(uri.fsPath).name;
    let score = 10;
    if (expectedSimpleType) {
      if (fileName === expectedSimpleType) {
        score += 120;
      } else if (fileName === `${expectedSimpleType}Impl`) {
        score += 110;
      } else if (fileName.startsWith(expectedSimpleType)) {
        score += 80;
      }
    }
    if (!best || score > best.score) {
      best = { uri, score };
    }
  }
  return best?.uri;
}

function toDefinitionUri(item: vscode.Location | vscode.LocationLink): vscode.Uri | undefined {
  const candidate = item as vscode.LocationLink;
  if (candidate.targetUri) {
    return candidate.targetUri;
  }
  return (item as vscode.Location).uri;
}

async function findJavaTypeFile(
  typeName: string,
  document: vscode.TextDocument,
  preferredImport: string | undefined,
  limit: number
): Promise<vscode.Uri | undefined> {
  const simpleType = baseJavaTypeName(typeName);
  if (!simpleType) {
    return undefined;
  }

  const candidates = await vscode.workspace.findFiles(`**/${simpleType}.java`, EXCLUDE_GLOB, limit);
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (preferredImport) {
    const expected = `${preferredImport.replace(/\./g, path.sep)}.java`;
    const byImport = candidates.find((item) => normalizePath(item.fsPath).endsWith(normalizePath(expected)));
    if (byImport) {
      return byImport;
    }
  }

  const currentDir = path.dirname(document.uri.fsPath).toLowerCase();
  return candidates
    .slice()
    .sort((a, b) => {
      const aScore = commonPrefixLength(currentDir, path.dirname(a.fsPath).toLowerCase());
      const bScore = commonPrefixLength(currentDir, path.dirname(b.fsPath).toLowerCase());
      return bScore - aScore;
    })[0];
}

async function findServiceImplFile(
  serviceType: string,
  serviceImport: string | undefined,
  document: vscode.TextDocument,
  limit: number
): Promise<vscode.Uri | undefined> {
  const simpleServiceType = baseJavaTypeName(serviceType);
  if (!simpleServiceType) {
    return undefined;
  }

  const implType = `${simpleServiceType}Impl`;
  let implImport = '';
  if (serviceImport && serviceImport.includes('.service.')) {
    implImport = `${serviceImport.replace('.service.', '.service.impl.')}Impl`;
  }
  const directImpl = await findJavaTypeFile(implType, document, implImport, limit);
  if (directImpl) {
    return directImpl;
  }

  const implCandidates = await vscode.workspace.findFiles('**/*Impl.java', EXCLUDE_GLOB, limit);
  for (const file of implCandidates) {
    const text = await fs.readFile(file.fsPath, 'utf8');
    const regex = new RegExp(`\\bimplements\\b[^{;]*\\b${escapeRegExp(simpleServiceType)}\\b`);
    if (regex.test(text)) {
      return file;
    }
  }
  return undefined;
}

function extractSqlResourceNames(mapperText: string, mapperType: string): string[] {
  const result: string[] = [];
  const add = (value: string): void => {
    const text = String(value || '').trim();
    if (!text) {
      return;
    }
    if (!result.find((item) => item.toLowerCase() === text.toLowerCase())) {
      result.push(text);
    }
  };

  const sqlResourceRegex = /@SqlResource\s*\(\s*["']([^"']+)["']\s*\)/gi;
  let match = sqlResourceRegex.exec(mapperText);
  while (match) {
    add(match[1]);
    match = sqlResourceRegex.exec(mapperText);
  }

  const resourceAttrRegex = /\bresource\s*=\s*["']([^"']+)["']/gi;
  match = resourceAttrRegex.exec(mapperText);
  while (match) {
    add(match[1]);
    match = resourceAttrRegex.exec(mapperText);
  }

  const mapperSimple = baseJavaTypeName(mapperType);
  if (mapperSimple) {
    add(mapperSimple);
    add(mapperSimple.replace(/Mapper$/i, ''));
  }
  return result;
}

async function resolveSqlEvidence(
  sqlResources: string[],
  currentDir: string,
  sqlSearchGlobs: string[],
  mapperMethod: string
): Promise<{ resource: string; file: vscode.Uri } | undefined> {
  for (const resource of sqlResources) {
    const file = await findSqlFileByResource(resource, currentDir, sqlSearchGlobs, mapperMethod);
    if (file) {
      return { resource, file };
    }
  }
  return undefined;
}

async function findSqlFileByResource(
  resourceName: string,
  currentDir: string,
  sqlSearchGlobs: string[],
  mapperMethod: string
): Promise<vscode.Uri | undefined> {
  const safeName = resourceName.trim();
  if (!safeName) {
    return undefined;
  }
  const sqlCandidates = await loadSqlCandidates(sqlSearchGlobs);
  if (sqlCandidates.length === 0) {
    return undefined;
  }

  const normalizedResource = normalizeResourceName(safeName);
  const targetBase = path.posix.basename(normalizedResource);
  // 关键逻辑: 先按路径规则粗排，再按内容命中（如 mapperMethod/id）精排。
  const pathRanked = sqlCandidates
    .map((uri) => ({
      uri,
      score: scoreSqlFileByPath(uri.fsPath, normalizedResource, targetBase, currentDir)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  let best: { uri: vscode.Uri; score: number } | undefined;
  for (const item of pathRanked) {
    let score = item.score;
    const sqlText = await readFileSafe(item.uri.fsPath);
    if (sqlText && mapperMethod) {
      const idRegex = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(mapperMethod)}["']`, 'i');
      if (idRegex.test(sqlText)) {
        score += 200;
      }
      if (sqlText.includes(mapperMethod)) {
        score += 80;
      }
    }
    if (!best || score > best.score) {
      best = { uri: item.uri, score };
    }
  }
  return best?.uri;
}

async function loadSqlCandidates(sqlSearchGlobs: string[]): Promise<vscode.Uri[]> {
  const normalizedGlobs = normalizeSqlGlobs(sqlSearchGlobs);
  const cacheKey = normalizedGlobs.join('||');
  const cached = SQL_CANDIDATE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const groups = await Promise.all(
    normalizedGlobs.map((glob) => vscode.workspace.findFiles(glob, EXCLUDE_GLOB, 500))
  );
  const dedupe = new Map<string, vscode.Uri>();
  for (const group of groups) {
    for (const uri of group) {
      dedupe.set(normalizePath(uri.fsPath), uri);
    }
  }
  const result = Array.from(dedupe.values());
  SQL_CANDIDATE_CACHE.set(cacheKey, result);
  return result;
}

function normalizeSqlGlobs(globs: string[]): string[] {
  const source = Array.isArray(globs) && globs.length > 0 ? globs : DEFAULT_SQL_SEARCH_GLOBS;
  return source.map((item) => String(item || '').trim()).filter((item) => item.length > 0);
}

function normalizeResourceName(resourceName: string): string {
  const normalized = normalizePath(resourceName).replace(/\.(md|sql|xml)$/i, '');
  return normalized.replace(/^\/+/, '');
}

function scoreSqlFileByPath(
  filePath: string,
  normalizedResource: string,
  targetBase: string,
  currentDir: string
): number {
  const normalizedFile = normalizePath(filePath);
  const fileBase = path.parse(normalizedFile).name.toLowerCase();
  const resourceBase = targetBase.toLowerCase();
  let score = 0;
  if (resourceBase && fileBase === resourceBase) {
    score += 160;
  } else if (resourceBase && fileBase.includes(resourceBase)) {
    score += 100;
  }
  if (normalizedResource && normalizedFile.includes(normalizedResource)) {
    score += 120;
  }
  if (normalizedFile.includes('/src/main/resources/')) {
    score += 20;
  }
  score += Math.floor(commonPrefixLength(currentDir, path.dirname(filePath).toLowerCase()) / 4);
  return score;
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractSqlByMethod(sqlText: string, mapperMethod: string, sqlFilePath: string): string {
  if (!sqlText) {
    return '';
  }
  const ext = path.extname(sqlFilePath).toLowerCase();
  if (ext === '.xml') {
    const xmlResult = extractMybatisSqlByMethod(sqlText, mapperMethod);
    if (xmlResult) {
      return xmlResult;
    }
  }
  const beetlResult = extractBeetlSqlByMethod(sqlText, mapperMethod);
  if (beetlResult) {
    return beetlResult;
  }
  return trimText(sqlText, 3000);
}

function extractMybatisSqlByMethod(sqlText: string, mapperMethod: string): string {
  const method = String(mapperMethod || '').trim();
  if (!method) {
    return '';
  }
  const statementRegex = new RegExp(
    `<(select|insert|update|delete)\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(method)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i'
  );
  const match = statementRegex.exec(sqlText);
  if (!match) {
    return '';
  }
  return String(match[0] || '').trim();
}

function extractBeetlSqlByMethod(sqlText: string, mapperMethod: string): string {
  const method = String(mapperMethod || '').trim();
  if (!sqlText || !method) {
    return '';
  }
  const sectionRegex = new RegExp(
    `(^|\\r?\\n)\\s*${escapeRegExp(method)}\\s*\\r?\\n\\s*=+\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\s*[^\\r\\n]+\\s*\\r?\\n\\s*=+\\s*\\r?\\n|$)`,
    'i'
  );
  const sectionMatch = sectionRegex.exec(sqlText);
  if (!sectionMatch) {
    return '';
  }
  const sectionBody = String(sectionMatch[2] || '').trim();
  if (!sectionBody) {
    return '';
  }
  const codeFenceMatch = /```(?:sql)?\s*([\s\S]*?)```/i.exec(sectionBody);
  if (codeFenceMatch && String(codeFenceMatch[1] || '').trim()) {
    return String(codeFenceMatch[1]).trim();
  }
  return sectionBody;
}

function baseJavaTypeName(typeName: string): string {
  if (!typeName) {
    return '';
  }
  const noArray = String(typeName).replace(/\[\]/g, '').trim();
  const noGeneric = noArray.replace(/<.*>/g, '').trim();
  const noWildcard = noGeneric.replace(/\? extends /g, '').replace(/\? super /g, '').trim();
  return noWildcard.split('.').at(-1) || noWildcard;
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').toLowerCase();
}

function commonPrefixLength(left: string, right: string): number {
  const min = Math.min(left.length, right.length);
  let i = 0;
  while (i < min && left[i] === right[i]) {
    i += 1;
  }
  return i;
}

function trimText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength)}\n// ...内容过长，已截断`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
