import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { collectProjectContextForPrompt } from './context-agent';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface MappingAnnotation {
  name: string;
  startLine: number;
  endLine: number;
  rawText: string;
}

interface MethodParam {
  raw: string;
  name: string;
  type: string;
  source: 'body' | 'query' | 'path' | 'header' | 'unknown';
  externalName?: string;
}

interface MethodSignature {
  methodName: string;
  params: MethodParam[];
}

interface AnnotationRequestInfo {
  method: HttpMethod;
  path: string;
  contentType: string;
}

interface ExtensionSettings {
  baseUrl: string;
  tokenVarName: string;
  tokenValue: string;
  autoFillTestParams: boolean;
  commonPropertyHints: Record<string, unknown>;
  aiEnabled: boolean;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  aiContextAgentPrompt: string;
  testDataFile: string;
  projectStructureHint: string;
  aiSystemPrompt: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionRootPath = '';

export function activate(context: vscode.ExtensionContext): void {
  extensionRootPath = context.extensionPath || '';
  outputChannel = vscode.window.createOutputChannel('SpringBoot HTTP Helper');
  context.subscriptions.push(outputChannel);
  log('INFO', '扩展已激活，等待执行命令 springHttpGenerator.createHttpFromMapping');

  const disposable = vscode.commands.registerCommand(
    'springHttpGenerator.createHttpFromMapping',
    async () => {
      log('INFO', '收到命令: springHttpGenerator.createHttpFromMapping');
      try {
        await createHttpFromCurrentMapping();
      } catch (error) {
        logError('命令执行失败', error);
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`生成 HTTP 请求失败: ${message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  log('INFO', '扩展已停用');
}

async function createHttpFromCurrentMapping(): Promise<void> {
  log('STEP', '开始执行 createHttpFromCurrentMapping');
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('未找到激活中的编辑器');
  }
  log('STEP', `当前文件: ${editor.document.fileName}`);

  const document = editor.document;
  if (document.languageId !== 'java') {
    throw new Error('当前文件不是 Java 文件');
  }

  const settings = getSettings();
  log('STEP', `配置读取完成: baseUrl=${settings.baseUrl}, tokenVar=${settings.tokenVarName}`);
  const allAnnotations = collectMappingAnnotations(document);
  log('STEP', `扫描到 Mapping 注解数量: ${allAnnotations.length}`);
  const cursorLine = editor.selection.active.line;
  const mapping = allAnnotations.find(
    (item) => cursorLine >= item.startLine && cursorLine <= item.endLine
  );

  if (!mapping) {
    throw new Error('请将光标放在 Mapping 注解上再执行');
  }
  log('STEP', `定位到注解: ${mapping.name}, 行范围: ${mapping.startLine}-${mapping.endLine}`);

  const methodSignature = parseMethodSignatureAfter(document, mapping.endLine);
  if (!methodSignature) {
    throw new Error('未能解析到 Mapping 注解对应的方法签名');
  }
  log('STEP', `解析方法签名成功: ${methodSignature.methodName}, 参数数: ${methodSignature.params.length}`);

  const className = parseClassName(document) ?? path.parse(document.fileName).name;
  const classBasePath = parseClassBasePath(document);
  const requestInfo = parseRequestInfoFromAnnotation(mapping.rawText);
  const requestPath = joinUrlPath(classBasePath, requestInfo.path);
  log('STEP', `解析请求成功: method=${requestInfo.method}, path=${requestPath}, contentType=${requestInfo.contentType}`);

  const prepared = await prepareRequestPayload(
    document,
    methodSignature.params,
    requestPath,
    requestInfo.method,
    methodSignature.methodName,
    settings
  );
  log('STEP', `请求参数准备完成: finalPath=${prepared.finalPath}, bodyLength=${prepared.bodyText.length}`);

  const targetFilePath = await resolveTargetHttpFilePath(document, className);
  log('STEP', `目标 HTTP 文件: ${targetFilePath}`);
  await appendHttpRequestSection(
    targetFilePath,
    className,
    methodSignature.methodName,
    requestInfo.method,
    prepared.finalPath,
    requestInfo.contentType,
    prepared.bodyText,
    settings
  );
  log('STEP', 'HTTP 请求片段写入完成');

  const httpDoc = await vscode.workspace.openTextDocument(targetFilePath);
  await vscode.window.showTextDocument(httpDoc, { preview: false });
  vscode.window.showInformationMessage(`已写入请求: ${path.basename(targetFilePath)}`);
}

async function resolveTargetHttpFilePath(document: vscode.TextDocument, className: string): Promise<string> {
  const projectRoot = getWorkspaceRootByDocument(document);
  const httpDir = path.join(projectRoot, 'http');
  await fs.mkdir(httpDir, { recursive: true });
  return path.join(httpDir, `${className}.http`);
}

function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('springHttpGenerator');
  return {
    baseUrl: config.get<string>('baseUrl', 'http://localhost:8080').trim() || 'http://localhost:8080',
    tokenVarName: config.get<string>('tokenVarName', 'token').trim() || 'token',
    tokenValue: config.get<string>('tokenValue', '').trim(),
    autoFillTestParams: config.get<boolean>('autoFillTestParams', true),
    commonPropertyHints: config.get<Record<string, unknown>>('commonPropertyHints', {}),
    aiEnabled: config.get<boolean>('ai.enabled', true),
    aiEndpoint: config.get<string>('ai.endpoint', 'https://api.openai.com/v1/responses').trim(),
    aiApiKey: config.get<string>('ai.apiKey', '').trim(),
    aiModel: config.get<string>('ai.model', 'gpt-5.1-codex-max').trim() || 'gpt-5.1-codex-max',
    aiContextAgentPrompt: config.get<string>(
      'ai.contextAgentPrompt',
      '你是代码检索智能体，采用 ReAct（Reason + Act）工作流。按 Controller -> Service -> Mapper -> SQL 顺序定位上下文，只输出结构化 JSON，最终仅返回 Service 与 SQL 的有效证据，不返回 Mapper 内容本体。优先结合方法体调用、字段注入与构造注入推断 Service。'
    ).trim(),
    testDataFile: config.get<string>('ai.testDataFile', '').trim(),
    projectStructureHint: config.get<string>('ai.projectStructureHint', '').trim(),
    aiSystemPrompt: config.get<string>(
      'ai.systemPrompt',
      '你是接口测试参数生成助手。仅输出 JSON 对象，且仅保留关键字段，禁止输出 aid 和 修改时间。'
    ).trim() || '你是接口测试参数生成助手。仅输出 JSON 对象，且仅保留关键字段，禁止输出 aid 和 修改时间。'
  };
}

function getWorkspaceRootByDocument(document: vscode.TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  return workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.fileName);
}

function resolveTestDataFilePath(document: vscode.TextDocument, settings: ExtensionSettings): string {
  const configured = settings.testDataFile?.trim() || '';
  const root = getWorkspaceRootByDocument(document);
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(root, configured);
  }
  return '';
}

function getBuiltinTestDataPathCandidates(): string[] {
  const candidates: string[] = [];
  if (extensionRootPath) {
    candidates.push(path.join(extensionRootPath, 'data', 'test-data-pools.json'));
  }
  candidates.push(path.resolve(__dirname, '..', 'data', 'test-data-pools.json'));
  return [...new Set(candidates)];
}

function getDefaultProjectTestDataPathCandidates(document: vscode.TextDocument): string[] {
  const root = getWorkspaceRootByDocument(document);
  return [
    path.join(root, 'data', 'test-data-pools.json'),
    path.join(root, 'data', 'test-data-pools')
  ];
}

async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadTestDataPools(
  document: vscode.TextDocument,
  settings: ExtensionSettings
): Promise<Record<string, unknown[]>> {
  const configuredPath = resolveTestDataFilePath(document, settings);
  let testDataPath = '';

  if (configuredPath) {
    if (!(await canReadFile(configuredPath))) {
      throw new Error(`配置的测试数据文件不存在: ${configuredPath}`);
    }
    testDataPath = configuredPath;
    log('STEP', `读取测试数据池(配置路径): ${testDataPath}`);
  } else {
    const localCandidates = getDefaultProjectTestDataPathCandidates(document);
    for (const p of localCandidates) {
      if (await canReadFile(p)) {
        testDataPath = p;
        log('STEP', `读取测试数据池(项目本地): ${testDataPath}`);
        break;
      }
    }
    if (!testDataPath) {
      const builtinCandidates = getBuiltinTestDataPathCandidates();
      for (const p of builtinCandidates) {
        if (await canReadFile(p)) {
          testDataPath = p;
          log('STEP', `读取测试数据池(插件内置): ${testDataPath}`);
          break;
        }
      }
    }
    if (!testDataPath) {
      throw new Error(
        `未找到测试数据文件。已尝试: ${[...localCandidates, ...getBuiltinTestDataPathCandidates()].join(' ; ')}`
      );
    }
  }

  const raw = await fs.readFile(testDataPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown[]>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`测试数据池文件格式无效: ${testDataPath}`);
  }
  return parsed;
}

function pickRandomItems(values: unknown[], maxCount: number): unknown[] {
  const source = Array.isArray(values) ? values.filter((item) => item !== undefined && item !== null) : [];
  if (source.length === 0) {
    return [];
  }
  const copy = source.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = copy[i];
    copy[i] = copy[j];
    copy[j] = t;
  }
  return copy.slice(0, Math.min(maxCount, copy.length));
}

function buildRandomPoolSnapshot(
  pools: Record<string, unknown[]>,
  maxEach = 10
): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(pools || {})) {
    if (Array.isArray(value)) {
      snapshot[key] = pickRandomItems(value, maxEach);
    }
  }
  return snapshot;
}

function shouldSkipField(fieldName: string): boolean {
  const name = String(fieldName || '').trim().toLowerCase();
  if (!name) {
    return true;
  }
  if (name === 'aid' || name === '修改时间') {
    return true;
  }
  return ['updatetime', 'modifytime', 'modifiedtime', 'gmtmodified', 'lastmodifiedtime'].includes(name);
}

function collectMappingAnnotations(document: vscode.TextDocument): MappingAnnotation[] {
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

function parseMethodSignatureAfter(
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
    ? splitJavaParameters(paramsText).map((part) => parseMethodParam(part)).filter((item): item is MethodParam => !!item)
    : [];

  return {
    methodName,
    params
  };
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

function parseClassName(document: vscode.TextDocument): string | undefined {
  const match = document.getText().match(/\bclass\s+(\w+)\b/);
  return match?.[1];
}

function parseClassBasePath(document: vscode.TextDocument): string {
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

function parseRequestInfoFromAnnotation(annotation: string): AnnotationRequestInfo {
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
  const pattern = new RegExp(`${key}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|'[^']*'|[\\w.]+)`);
  const found = args.match(pattern);
  return found?.[1]?.trim();
}

function extractFirstStringLiteral(raw: string): string | undefined {
  const stringMatch = raw.match(/"([^"]*)"|'([^']*)'/);
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

function joinUrlPath(basePath: string, methodPath: string): string {
  const left = normalizePathPart(basePath);
  const right = normalizePathPart(methodPath);
  if (!left && !right) return '/';
  if (!left) return `/${right}`;
  if (!right) return `/${left}`;
  return `/${left}/${right}`;
}

function normalizePathPart(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function isQueryByPageRequest(requestPath: string): boolean {
  return /query-by-page/i.test(requestPath);
}

function ensurePaginationFieldsOnPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return [{ current: 1, pageSize: 10 }];
    }
    const next = payload.slice();
    next[0] = ensurePaginationFieldsOnPayload(next[0]);
    return next;
  }
  if (!payload || typeof payload !== 'object') {
    return { current: 1, pageSize: 10 };
  }
  const next = { ...(payload as Record<string, unknown>) };
  if (next.current === undefined) {
    next.current = 1;
  }
  if (next.pageSize === undefined) {
    next.pageSize = 10;
  }
  return next;
}

async function prepareRequestPayload(
  document: vscode.TextDocument,
  params: MethodParam[],
  requestPath: string,
  requestMethod: HttpMethod,
  methodName: string,
  settings: ExtensionSettings
): Promise<{ finalPath: string; bodyText: string }> {
  let finalPath = requestPath;
  const bodyParam = params.find((item) => item.source === 'body');
  const needPaginationByPath = isQueryByPageRequest(finalPath);
  const needPaginationByBody = bodyParam
    ? await isTypeExtendsPageSearchVo(bodyParam.type, document, new Set())
    : false;
  const needPagination = needPaginationByPath || needPaginationByBody;

  if (needPagination) {
    log('STEP', '命中分页接口规则，将只在 JSON body 中补齐 current=1,pageSize=10');
  }

  // 路径变量替换为示例值，避免请求无法直接执行
  const pathParams = params.filter((item) => item.source === 'path');
  for (const param of pathParams) {
    const key = param.externalName || param.name;
    const sampleValue = toScalarValueString(
      createSampleScalar(param.type, param.name, settings.commonPropertyHints)
    );
    finalPath = finalPath.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, 'g'), sampleValue);
  }

  // 查询参数统一挂到 URL 上，便于直接点击发送
  const queryParams = params.filter(
    (item) =>
      (item.source === 'query' || (item.source === 'unknown' && requestMethod === 'GET')) &&
      !shouldSkipField(item.externalName || item.name)
  );
  if (queryParams.length > 0) {
    const queryString = queryParams
      .map((item) => {
        const key = item.externalName || item.name;
        const value = toScalarValueString(
          createSampleScalar(item.type, item.name, settings.commonPropertyHints)
        );
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');
    finalPath = `${finalPath}${finalPath.includes('?') ? '&' : '?'}${queryString}`;
  }

  if (!bodyParam || !settings.autoFillTestParams || requestMethod === 'GET' || requestMethod === 'DELETE') {
    if (bodyParam && needPagination && requestMethod !== 'GET' && requestMethod !== 'DELETE') {
      const pagingOnlyBody = ensurePaginationFieldsOnPayload({});
      return { finalPath, bodyText: JSON.stringify(pagingOnlyBody, null, 2) };
    }
    return { finalPath, bodyText: '' };
  }

  let localBody = await buildBodyPayloadFromParam(document, bodyParam, settings.commonPropertyHints, new Set());
  log('STEP', `本地请求体构建完成: param=${bodyParam.name}, bodyType=${Array.isArray(localBody) ? 'array' : typeof localBody}`);
  localBody = enforcePlatformSiteCustomerShortNameRule(localBody);
  log('STEP', '本地请求体规范化完成: 已应用 platform-site-customerShortName 关联规则');
  if (needPagination) {
    localBody = ensurePaginationFieldsOnPayload(localBody);
  }
  if (localBody === null || typeof localBody !== 'object') {
    return {
      finalPath,
      bodyText: JSON.stringify(localBody, null, 2)
    };
  }
  log('STEP', `开始 AI 请求体生成: method=${methodName}, bodyParam=${bodyParam.name}`);
  let finalBody = await tryBuildBodyWithAI(document, bodyParam, localBody, methodName, settings);
  log('STEP', 'AI 请求体生成完成');
  finalBody = enforcePlatformSiteCustomerShortNameRule(finalBody);
  log('STEP', 'AI 请求体规范化完成: 已应用 platform-site-customerShortName 关联规则');
  if (needPagination) {
    finalBody = ensurePaginationFieldsOnPayload(finalBody);
  }
  return {
    finalPath,
    bodyText: JSON.stringify(finalBody, null, 2)
  };
}

async function buildBodyPayloadFromParam(
  document: vscode.TextDocument,
  param: MethodParam,
  hints: Record<string, unknown>,
  visitedTypes: Set<string>
): Promise<unknown> {
  const simpleType = normalizeJavaType(param.type);

  if (isScalarType(simpleType)) {
    return createSampleScalar(simpleType, param.name, hints);
  }

  if (isCollectionType(simpleType)) {
    const elementType = extractCollectionElementType(param.type);
    if (!elementType) {
      return [];
    }
    const itemValue = await buildBodyPayloadFromType(document, elementType, `${param.name}Item`, hints, visitedTypes);
    return [itemValue];
  }

  return buildBodyPayloadFromType(document, simpleType, param.name, hints, visitedTypes);
}

async function buildBodyPayloadFromType(
  document: vscode.TextDocument,
  typeName: string,
  fieldName: string,
  hints: Record<string, unknown>,
  visitedTypes: Set<string>
): Promise<unknown> {
  const simpleType = normalizeJavaType(typeName);

  if (isScalarType(simpleType)) {
    return createSampleScalar(simpleType, fieldName, hints);
  }
  if (visitedTypes.has(simpleType)) {
    return {};
  }
  visitedTypes.add(simpleType);

  const dtoFile = await findJavaTypeFile(simpleType, document);
  if (!dtoFile) {
    return createFallbackObject(fieldName, hints);
  }

  const dtoText = await fs.readFile(dtoFile.fsPath, 'utf8');
  const fields = parseJavaFields(dtoText);
  if (fields.length === 0) {
    return createFallbackObject(fieldName, hints);
  }

  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const normalized = normalizeJavaType(field.type);
    if (isCollectionType(normalized)) {
      const elementType = extractCollectionElementType(field.type);
      payload[field.name] = elementType
        ? [await buildBodyPayloadFromType(document, elementType, field.name, hints, visitedTypes)]
        : [];
      continue;
    }
    if (isScalarType(normalized)) {
      payload[field.name] = createSampleScalar(normalized, field.name, hints);
      continue;
    }
    payload[field.name] = await buildBodyPayloadFromType(document, normalized, field.name, hints, visitedTypes);
  }

  visitedTypes.delete(simpleType);
  return payload;
}

function parseJavaFields(javaText: string): Array<{ type: string; name: string }> {
  const regex = /^\s*(?:private|protected|public)\s+(?!static\b)(?!final\b)([A-Za-z0-9_<>\[\].?, ]+)\s+([A-Za-z0-9_]+)\s*(?:=[^;]*)?;/gm;
  const fields: Array<{ type: string; name: string }> = [];
  let match: RegExpExecArray | null = regex.exec(javaText);
  while (match) {
    if (shouldSkipField(match[2])) {
      match = regex.exec(javaText);
      continue;
    }
    fields.push({
      type: match[1].trim(),
      name: match[2].trim()
    });
    match = regex.exec(javaText);
  }
  return fields;
}

async function findJavaTypeFile(
  typeName: string,
  currentDocument: vscode.TextDocument
): Promise<vscode.Uri | undefined> {
  const searchName = `${typeName}.java`;
  const candidates = await vscode.workspace.findFiles(
    `**/${searchName}`,
    '**/{target,build,out,node_modules,.git}/**',
    30
  );
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  // 多结果时优先选与当前 Controller 路径最接近的类型文件
  const currentDir = path.dirname(currentDocument.uri.fsPath).toLowerCase();
  return candidates
    .slice()
    .sort((a, b) => {
      const aScore = commonPrefixLength(currentDir, path.dirname(a.fsPath).toLowerCase());
      const bScore = commonPrefixLength(currentDir, path.dirname(b.fsPath).toLowerCase());
      return bScore - aScore;
    })[0];
}

async function isTypeExtendsPageSearchVo(
  typeName: string,
  document: vscode.TextDocument,
  visitedTypes: Set<string>
): Promise<boolean> {
  const simpleType = baseJavaTypeName(typeName);
  if (!simpleType) {
    return false;
  }
  if (simpleType === 'PageSearchVo') {
    return true;
  }
  if (visitedTypes.has(simpleType)) {
    return false;
  }
  visitedTypes.add(simpleType);

  const dtoFile = await findJavaTypeFile(simpleType, document);
  if (!dtoFile) {
    return false;
  }
  const dtoText = await fs.readFile(dtoFile.fsPath, 'utf8');
  const parentType = parseParentClassType(dtoText, simpleType);
  if (!parentType) {
    return false;
  }
  const parentSimple = baseJavaTypeName(parentType);
  if (parentSimple === 'PageSearchVo') {
    return true;
  }
  return isTypeExtendsPageSearchVo(parentSimple, document, visitedTypes);
}

async function buildRequestBodyTypeContextForAI(
  typeName: string,
  document: vscode.TextDocument
): Promise<{
  entryType: string;
  typeChain: string[];
  fields: Array<{ type: string; name: string }>;
  sourceContext: string;
}> {
  const entryType = resolveRequestBodyEntryType(typeName);
  const visited = new Set<string>();
  const typeChain: string[] = [];
  const sourceChunks: string[] = [];
  const fieldMap = new Map<string, { type: string; name: string }>();

  let currentType = entryType;
  let depth = 0;
  while (currentType && depth < 6 && !visited.has(currentType)) {
    visited.add(currentType);
    typeChain.push(currentType);
    const dtoFile = await findJavaTypeFile(currentType, document);
    if (!dtoFile) {
      sourceChunks.push(`// 未找到类型源码: ${currentType}`);
      break;
    }

    const dtoText = await fs.readFile(dtoFile.fsPath, 'utf8');
    sourceChunks.push(`// 类型: ${currentType} 文件: ${dtoFile.fsPath}\n${trimTextForPrompt(dtoText, 8000)}`);

    const aiFields = parseJavaFieldsForAI(dtoText);
    for (const field of aiFields) {
      const key = `${field.name}:${field.type}`;
      if (!fieldMap.has(key)) {
        fieldMap.set(key, field);
      }
    }

    const parentType = parseParentClassType(dtoText, currentType);
    currentType = parentType ? baseJavaTypeName(parentType) : '';
    depth += 1;
  }

  return {
    entryType,
    typeChain,
    fields: Array.from(fieldMap.values()),
    sourceContext: sourceChunks.join('\n\n')
  };
}

function resolveRequestBodyEntryType(typeName: string): string {
  const normalized = normalizeJavaType(typeName);
  if (isCollectionType(normalized)) {
    const element = extractCollectionElementType(typeName);
    return baseJavaTypeName(element || normalized);
  }
  return baseJavaTypeName(normalized);
}

function parseJavaFieldsForAI(javaText: string): Array<{ type: string; name: string }> {
  const regex = /^\s*(?:private|protected|public)\s+(?!static\b)(?!final\b)([A-Za-z0-9_<>\[\].?, ]+)\s+([A-Za-z0-9_]+)\s*(?:=[^;]*)?;/gm;
  const fields: Array<{ type: string; name: string }> = [];
  let match: RegExpExecArray | null = regex.exec(javaText);
  while (match) {
    fields.push({
      type: match[1].trim(),
      name: match[2].trim()
    });
    match = regex.exec(javaText);
  }
  return fields;
}

function trimTextForPrompt(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength)}\n// ...源码过长，已截断`;
}

function parseParentClassType(javaText: string, className: string): string | undefined {
  const escaped = escapeRegExp(className);
  const re = new RegExp(`\\bclass\\s+${escaped}\\b[^\\{]*\\bextends\\s+([A-Za-z0-9_$.<>?]+)`, 'm');
  const match = javaText.match(re);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].trim();
}

function baseJavaTypeName(typeName: string): string {
  if (!typeName) {
    return '';
  }
  const noArray = String(typeName).replace(/\[\]/g, '').trim();
  const withoutGeneric = noArray.replace(/<.*>/g, '').trim();
  const noWildcard = withoutGeneric.replace(/\? extends /g, '').replace(/\? super /g, '').trim();
  return noWildcard.split('.').at(-1) ?? noWildcard;
}

function commonPrefixLength(left: string, right: string): number {
  const min = Math.min(left.length, right.length);
  let i = 0;
  while (i < min && left[i] === right[i]) {
    i += 1;
  }
  return i;
}

function createSampleScalar(typeName: string, fieldName: string, hints: Record<string, unknown>): unknown {
  const directHint = findHintByName(fieldName, hints);
  if (directHint !== undefined) {
    return directHint;
  }

  const normalizedType = normalizeJavaType(typeName);
  const lowerName = fieldName.toLowerCase();

  if (lowerName.includes('phone') || lowerName.includes('mobile')) return '13800000000';
  if (lowerName.includes('email')) return 'demo@example.com';
  if (lowerName.endsWith('id') || lowerName === 'id') return '1';
  if (lowerName.includes('name')) return '测试名称';
  if (lowerName.includes('code')) return 'TEST_CODE';
  if (lowerName.includes('status')) {
    if (['Integer', 'Long', 'Short', 'Byte', 'int', 'long', 'short', 'byte'].includes(normalizedType)) return 1;
    if (['Boolean', 'boolean'].includes(normalizedType)) return true;
    return 'ENABLED';
  }
  if (lowerName.includes('remark') || lowerName.includes('desc')) return '测试备注';

  if (['String', 'CharSequence', 'UUID'].includes(normalizedType)) return `test_${fieldName}`;
  if (['Integer', 'Long', 'Short', 'Byte', 'int', 'long', 'short', 'byte'].includes(normalizedType)) return 1;
  if (['Double', 'Float', 'double', 'float', 'BigDecimal'].includes(normalizedType)) return 1.0;
  if (['Boolean', 'boolean'].includes(normalizedType)) return true;
  if (['LocalDate', 'Date'].includes(normalizedType)) return '2026-01-01';
  if (['LocalDateTime', 'Instant', 'Timestamp', 'OffsetDateTime', 'ZonedDateTime'].includes(normalizedType)) {
    return '2026-01-01T00:00:00';
  }
  return `test_${fieldName}`;
}

function findHintByName(fieldName: string, hints: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(hints, fieldName)) {
    return hints[fieldName];
  }
  const lower = fieldName.toLowerCase();
  const key = Object.keys(hints).find((item) => item.toLowerCase() === lower);
  return key ? hints[key] : undefined;
}

function normalizeJavaType(typeName: string): string {
  const noPackage = typeName.trim().split('.').at(-1) ?? typeName.trim();
  return noPackage.replace(/\? extends /g, '').replace(/\? super /g, '').replace(/\[\]/g, '[]').trim();
}

function isScalarType(typeName: string): boolean {
  const simple = normalizeJavaType(typeName);
  return [
    'String',
    'CharSequence',
    'UUID',
    'Integer',
    'Long',
    'Short',
    'Byte',
    'int',
    'long',
    'short',
    'byte',
    'Double',
    'Float',
    'double',
    'float',
    'BigDecimal',
    'Boolean',
    'boolean',
    'LocalDate',
    'LocalDateTime',
    'Date',
    'Instant',
    'Timestamp',
    'OffsetDateTime',
    'ZonedDateTime'
  ].includes(simple);
}

function isCollectionType(typeName: string): boolean {
  const simple = normalizeJavaType(typeName);
  return /^(List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|Map|HashMap|LinkedHashMap)\b/.test(simple) || simple.endsWith('[]');
}

function extractCollectionElementType(typeName: string): string | undefined {
  const simple = typeName.trim();
  if (simple.endsWith('[]')) {
    return simple.slice(0, -2).trim();
  }
  const genericMatch = simple.match(/<(.+)>/);
  if (!genericMatch) {
    return undefined;
  }
  const genericContent = genericMatch[1];
  const parts = splitJavaParameters(genericContent);
  if (parts.length === 0) {
    return undefined;
  }
  return parts[0].trim();
}

function createFallbackObject(fieldName: string, hints: Record<string, unknown>): Record<string, unknown> {
  return {
    id: createSampleScalar('String', 'id', hints),
    name: createSampleScalar('String', fieldName || 'name', hints)
  };
}

function toScalarValueString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryBuildBodyWithAI(
  document: vscode.TextDocument,
  bodyParam: MethodParam,
  localBody: unknown,
  methodName: string,
  settings: ExtensionSettings
): Promise<unknown> {
  if (!settings.aiEnabled) {
    throw new Error('AI 参数生成已关闭。请开启配置 springHttpGenerator.ai.enabled');
  }
  if (!settings.aiEndpoint) {
    throw new Error('未配置 OpenAI Responses 接口地址，请设置 springHttpGenerator.ai.endpoint');
  }
  if (!settings.aiApiKey) {
    throw new Error('未配置 OpenAI API Key，请设置 springHttpGenerator.ai.apiKey');
  }

  log('STEP', `开始 AI 参数补全(Responses): endpoint=${settings.aiEndpoint}, model=${settings.aiModel}`);
  const controllerText = document.getText();
  log('STEP', 'AI 参数流程: 开始读取测试数据池');
  const testDataPools = await loadTestDataPools(document, settings);
  const poolKeys = Object.keys(testDataPools);
  log('STEP', `AI 参数流程: 测试数据池读取完成，分类数=${poolKeys.length}`);
  const randomPoolSnapshot = buildRandomPoolSnapshot(testDataPools, 10);
  const bodyType = normalizeJavaType(bodyParam.type);
  const bodyShape = isCollectionType(bodyType) ? 'array' : 'object';
  log('STEP', `AI 参数流程: 开始构建请求体类型上下文, bodyType=${bodyType}`);
  const bodyTypeContext = await buildRequestBodyTypeContextForAI(bodyParam.type, document);
  log(
    'STEP',
    `AI 参数流程: 请求体类型上下文完成, typeChain=${bodyTypeContext.typeChain.join(' -> ') || 'N/A'}, fieldCount=${bodyTypeContext.fields.length}`
  );
  log('STEP', 'AI 参数流程: 开始采集业务上下文(Service/Mapper/SQL)');
  const projectContext = await collectProjectContextForPrompt({
    document,
    methodName,
    projectStructureHint: settings.projectStructureHint,
    logger: log,
    aiEndpoint: settings.aiEndpoint,
    aiApiKey: settings.aiApiKey,
    aiModel: settings.aiModel,
    reactSystemPrompt: settings.aiContextAgentPrompt
  });
  log('STEP', `AI 参数流程: 业务上下文采集完成, summary=${projectContext.summary}, contextLength=${projectContext.contextText}`);

  const prompt = [
    '根据 Java 字段和随机测试数据池生成最小化测试请求体。',
    '硬性规则:',
    '1) 仅返回 JSON，不要 markdown，不要解释。',
    '2) 只保留关键字段，字段数量尽量少（建议 3~6 个）。',
    '3) 字段名必须来自候选字段，绝对不要输出 aid 和 修改时间。',
    '4) 字段值优先从随机数据池中取值；能匹配编码类字段时优先使用编码值。',
    `5) body 形态必须是: ${bodyShape}`,
    '6) 必须阅读请求体类字段注解/注释中的约束并遵守。',
    '7) 若字段注释包含枚举语义（例如 "状态 0未占用 1已占用 2已使用"），该字段值只能取合法选项之一。',
    '8) 平台站点规则必须满足: 当 platform=Temu 时，site 与 customerShortName 必须是 Temu.*；当 platform 为 VC 平台（如 VC/VC平台）时，site 与 customerShortName 必须是 VC-Amazon.*；site 与 customerShortName 保持一致。',
    '',
    `参数类型: ${bodyParam.type}`,
    `参数名称: ${bodyParam.name}`,
    `请求体类型链: ${bodyTypeContext.typeChain.join(' -> ')}`,
    `请求体全部字段(类型): ${JSON.stringify(bodyTypeContext.fields)}`,
    `候选字段(JSON): ${JSON.stringify(localBody)}`,
    `字段提示(JSON): ${JSON.stringify(settings.commonPropertyHints)}`,
    `随机测试数据池(JSON): ${JSON.stringify(randomPoolSnapshot)}`,
    `Controller片段: ${controllerText.slice(0, 6000)}`,
    `请求体类源码(含注解和注释): ${bodyTypeContext.sourceContext}`,
    `Service/Mapper/SQL上下文: ${projectContext.contextText}`
  ].join('\n');
  log('STEP', `AI 参数流程: Prompt 构建完成, length=${prompt.length}`);

  const payload = {
    model: settings.aiModel,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: settings.aiSystemPrompt
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt
          }
        ]
      }
    ]
  };

  log('STEP', 'AI 参数流程: 开始发送 OpenAI Responses 请求');
  const response = await fetch(settings.aiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.aiApiKey}`
    },
    body: JSON.stringify(payload)
  });
  log('STEP', `AI 参数流程: OpenAI Responses 返回, status=${response.status}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI Responses 请求失败: HTTP ${response.status}, body=${body}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const contentText = extractResponsesOutputText(result);
  log('STEP', `AI 参数流程: 响应解析完成, outputTextLength=${contentText.length}`);
  const parsed = parseFirstJsonObject(contentText);
  if (!parsed) {
    throw new Error(`AI 输出不是有效 JSON: ${contentText}`);
  }
  const cleaned = removeExcludedFields(parsed);
  const normalized = enforcePlatformSiteCustomerShortNameRule(cleaned);
  log('STEP', 'AI 参数补全完成: 成功解析 JSON、字段过滤并完成平台站点规则规范化');
  return normalized;
}

function parseFirstJsonObject(text: string): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    // 部分模型会包裹说明文字，这里提取第一个 JSON 对象再解析
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore
    }
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart === -1 || arrEnd === -1 || arrEnd <= arrStart) {
    return undefined;
  }
  const arrCandidate = text.slice(arrStart, arrEnd + 1);
  try {
    return JSON.parse(arrCandidate);
  } catch {
    return undefined;
  }
}

function extractResponsesOutputText(result: Record<string, unknown>): string {
  if (typeof result.output_text === 'string' && result.output_text.trim()) {
    return result.output_text.trim();
  }
  if (!Array.isArray(result.output)) {
    return '';
  }
  const textParts: string[] = [];
  for (const item of result.output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const message = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
    if (message.type !== 'message' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
  }
  return textParts.join('\n').trim();
}

function removeExcludedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => removeExcludedFields(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (shouldSkipField(key)) {
      continue;
    }
    result[key] = removeExcludedFields(raw);
  }
  return result;
}

function enforcePlatformSiteCustomerShortNameRule(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => enforcePlatformSiteCustomerShortNameRule(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    normalized[key] = enforcePlatformSiteCustomerShortNameRule(raw);
  }

  const platformKey = findMatchedKey(normalized, ['platform']);
  if (!platformKey) {
    return normalized;
  }
  const siteKey = findMatchedKey(normalized, ['site']);
  const customerShortNameKey = findMatchedKey(normalized, ['customerShortName', 'customer_short_name']);
  if (!siteKey && !customerShortNameKey) {
    return normalized;
  }

  const platformValue = String(normalized[platformKey] ?? '').trim();
  const rule = resolvePlatformSiteRule(platformValue);
  if (!rule) {
    return normalized;
  }

  const currentSite = siteKey ? String(normalized[siteKey] ?? '').trim() : '';
  const currentCustomer = customerShortNameKey ? String(normalized[customerShortNameKey] ?? '').trim() : '';
  const candidate = currentSite || currentCustomer || `${rule.prefix}US`;
  const finalSite = normalizeSiteByPrefix(candidate, rule.prefix);

  if (siteKey) {
    normalized[siteKey] = finalSite;
  }
  if (customerShortNameKey) {
    normalized[customerShortNameKey] = finalSite;
  }
  return normalized;
}

function findMatchedKey(target: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(target);
  for (const candidate of candidates) {
    const found = keys.find((item) => item.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return undefined;
}

function resolvePlatformSiteRule(platform: string): { prefix: string } | undefined {
  const normalized = platform.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.replace(/\s+/g, '');
  if (compact === 'temu' || compact.startsWith('temu')) {
    return { prefix: 'Temu.' };
  }
  if (/^vc([_-]?(platform|平台))?$/.test(compact) || compact.startsWith('vc平台')) {
    return { prefix: 'VC-Amazon.' };
  }
  return undefined;
}

function normalizeSiteByPrefix(input: string, prefix: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return `${prefix}US`;
  }
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }

  const suffix = extractSiteSuffix(trimmed);
  return `${prefix}${suffix || 'US'}`;
}

function extractSiteSuffix(value: string): string {
  const text = value.trim();
  if (!text) {
    return '';
  }

  const delimiters = ['.', '-', '_', '/'];
  for (const delimiter of delimiters) {
    if (text.includes(delimiter)) {
      const part = text.split(delimiter).filter((item) => item).at(-1) ?? '';
      return part.trim();
    }
  }
  return text;
}

async function appendHttpRequestSection(
  filePath: string,
  className: string,
  methodName: string,
  httpMethod: HttpMethod,
  requestPath: string,
  contentType: string,
  bodyText: string,
  settings: ExtensionSettings
): Promise<void> {
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }

  if (exists && settings.tokenValue) {
    await upsertTokenVariable(filePath, settings.tokenVarName, settings.tokenValue);
  }

  const header = exists ? '' : buildHttpFileHeader(settings.baseUrl, settings.tokenVarName, settings.tokenValue);
  const section = buildRequestSection(
    className,
    methodName,
    httpMethod,
    requestPath,
    contentType,
    bodyText,
    settings.tokenVarName
  );

  const content = `${exists ? '\n' : ''}${header}${section}`;
  await fs.appendFile(filePath, content, 'utf8');
}

async function upsertTokenVariable(filePath: string, tokenVarName: string, tokenValue: string): Promise<void> {
  const raw = await fs.readFile(filePath, 'utf8');
  const escaped = escapeRegExp(tokenVarName);
  const lineRegex = new RegExp(`^@${escaped}\\s*=.*$`, 'm');
  const targetLine = `@${tokenVarName} = ${tokenValue}`;

  let next = raw;
  if (lineRegex.test(raw)) {
    next = raw.replace(lineRegex, targetLine);
  } else {
    next = `${targetLine}\n${raw}`;
  }

  if (next !== raw) {
    await fs.writeFile(filePath, next, 'utf8');
  }
}

function buildHttpFileHeader(baseUrl: string, tokenVarName: string, tokenValue: string): string {
  return [
    `@baseUrl = ${baseUrl}`,
    `@${tokenVarName} = ${tokenValue || ''}`,
    '',
    '# TODO: 在这里补充获取 token 的请求（当前留白）',
    '# 例如:',
    '# POST {{baseUrl}}/auth/token',
    '# Content-Type: application/json',
    '#',
    '# {',
    '#   "username": "your-username",',
    '#   "password": "your-password"',
    '# }',
    ''
  ].join('\n');
}

function buildRequestSection(
  className: string,
  methodName: string,
  httpMethod: HttpMethod,
  requestPath: string,
  contentType: string,
  bodyText: string,
  tokenVarName: string
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    `### ${now} ${className}.${methodName}`,
    `${httpMethod} {{baseUrl}}${requestPath}`,
    `Content-Type: ${contentType}`,
    `Authorization: {{${tokenVarName}}}`,
    ''
  ];

  if (bodyText) {
    lines.push(bodyText);
  }
  lines.push('');
  return lines.join('\n');
}

function log(level: 'INFO' | 'STEP' | 'ERROR', message: string): void {
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}`;
  outputChannel?.appendLine(line);
  if (level === 'ERROR') {
    console.error(line);
    return;
  }
  console.log(line);
}

function logError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
  log('ERROR', `${title}: ${message}${stack}`);
}
