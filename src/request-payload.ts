import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpringHttpGeneratorConfig } from './config';
import { collectProjectContextForPrompt } from './context-agent';
import { HttpMethod, MethodParam } from './http-request-parser';
import { LogLevel } from './logger';

// 文件作用: 组装请求路径与请求体，并在需要时调用 AI 生成最小化测试参数。
const PAGINATION_PAGE_NUM = 1;
const PAGINATION_PAGE_SIZE = 10;

type Logger = (level: LogLevel, message: string) => void;

interface PrepareRequestPayloadOptions {
  extensionRootPath: string;
  logger: Logger;
}

export async function prepareRequestPayload(
  document: vscode.TextDocument,
  params: MethodParam[],
  requestPath: string,
  requestMethod: HttpMethod,
  methodName: string,
  settings: SpringHttpGeneratorConfig,
  options: PrepareRequestPayloadOptions
): Promise<{ finalPath: string; bodyText: string }> {
  const { extensionRootPath, logger: log } = options;
  let finalPath = requestPath;
  const bodyParam = params.find((item) => item.source === 'body');
  const needPaginationByPath = isQueryByPageRequest(finalPath);
  const needPaginationByBody = bodyParam
    ? await isTypeExtendsPageSearchVo(bodyParam.type, document, new Set())
    : false;
  const needPagination = needPaginationByPath || needPaginationByBody;

  if (needPagination) {
    log(
      'STEP',
      `命中分页接口规则，将只在 JSON body 中补齐 current=${PAGINATION_PAGE_NUM},pageSize=${PAGINATION_PAGE_SIZE}`
    );
  }

  // 路径变量替换为示例值，避免请求无法直接执行
  const pathParams = params.filter((item) => item.source === 'path');
  for (const param of pathParams) {
    const key = param.externalName || param.name;
    const sampleValue = toScalarValueString(createSampleScalar(param.type, param.name));
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
        const value = toScalarValueString(createSampleScalar(item.type, item.name));
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');
    finalPath = `${finalPath}${finalPath.includes('?') ? '&' : '?'}${queryString}`;
  }

  if (!bodyParam || requestMethod === 'GET' || requestMethod === 'DELETE') {
    return { finalPath, bodyText: '' };
  }

  let localBody = await buildBodyPayloadFromParam(document, bodyParam, new Set());
  log(
    'STEP',
    `本地请求体构建完成: param=${bodyParam.name}, bodyType=${Array.isArray(localBody) ? 'array' : typeof localBody}`
  );
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
  let finalBody: unknown = localBody;
  if (settings.aiApiKey) {
    log('STEP', `开始 AI 请求体生成: method=${methodName}, bodyParam=${bodyParam.name}`);
    finalBody = await tryBuildBodyWithAI(
      document,
      bodyParam,
      localBody,
      methodName,
      settings,
      extensionRootPath,
      log
    );
    log('STEP', 'AI 请求体生成完成');
  } else {
    log('STEP', '未配置 AI API Key，本次使用本地请求体生成');
  }
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

function getWorkspaceRootByDocument(document: vscode.TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  return workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.fileName);
}

async function readSourceFileByPath(filePath: string): Promise<string> {
  if (!filePath) {
    throw new Error('源码路径为空，无法读取 Controller 源码');
  }
  return fs.readFile(filePath, 'utf8');
}

function resolveTestDataFilePath(document: vscode.TextDocument, settings: SpringHttpGeneratorConfig): string {
  const configured = settings.testDataFile?.trim() || '';
  const root = getWorkspaceRootByDocument(document);
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(root, configured);
  }
  return '';
}

function getBuiltinTestDataPathCandidates(extensionRootPath: string): string[] {
  const candidates: string[] = [];
  if (extensionRootPath) {
    candidates.push(path.join(extensionRootPath, 'data', 'test-data-pools.json'));
  }
  candidates.push(path.resolve(__dirname, '..', 'data', 'test-data-pools.json'));
  return [...new Set(candidates)];
}

function getDefaultProjectTestDataPathCandidates(document: vscode.TextDocument): string[] {
  const root = getWorkspaceRootByDocument(document);
  return [path.join(root, 'data', 'test-data-pools.json'), path.join(root, 'data', 'test-data-pools')];
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
  settings: SpringHttpGeneratorConfig,
  extensionRootPath: string,
  log: Logger
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
      const builtinCandidates = getBuiltinTestDataPathCandidates(extensionRootPath);
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
        `未找到测试数据文件。已尝试: ${[
          ...localCandidates,
          ...getBuiltinTestDataPathCandidates(extensionRootPath)
        ].join(' ; ')}`
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

function isQueryByPageRequest(requestPath: string): boolean {
  return /query-by-page/i.test(requestPath);
}

function ensurePaginationFieldsOnPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return [{ current: PAGINATION_PAGE_NUM, pageSize: PAGINATION_PAGE_SIZE }];
    }
    const next = payload.slice();
    next[0] = ensurePaginationFieldsOnPayload(next[0]);
    return next;
  }
  if (!payload || typeof payload !== 'object') {
    return { current: PAGINATION_PAGE_NUM, pageSize: PAGINATION_PAGE_SIZE };
  }
  const next = { ...(payload as Record<string, unknown>) };
  if (next.current === undefined) {
    next.current = PAGINATION_PAGE_NUM;
  }
  if (next.pageSize === undefined) {
    next.pageSize = PAGINATION_PAGE_SIZE;
  }
  return next;
}

async function buildBodyPayloadFromParam(
  document: vscode.TextDocument,
  param: MethodParam,
  visitedTypes: Set<string>
): Promise<unknown> {
  const simpleType = normalizeJavaType(param.type);

  if (isScalarType(simpleType)) {
    return createSampleScalar(simpleType, param.name);
  }

  if (isCollectionType(simpleType)) {
    const elementType = extractCollectionElementType(param.type);
    if (!elementType) {
      return [];
    }
    const itemValue = await buildBodyPayloadFromType(document, elementType, `${param.name}Item`, visitedTypes);
    return [itemValue];
  }

  return buildBodyPayloadFromType(document, simpleType, param.name, visitedTypes);
}

async function buildBodyPayloadFromType(
  document: vscode.TextDocument,
  typeName: string,
  fieldName: string,
  visitedTypes: Set<string>
): Promise<unknown> {
  const simpleType = normalizeJavaType(typeName);

  if (isScalarType(simpleType)) {
    return createSampleScalar(simpleType, fieldName);
  }
  if (visitedTypes.has(simpleType)) {
    return {};
  }
  visitedTypes.add(simpleType);
  try {
    const dtoFile = await findJavaTypeFile(simpleType, document);
    if (!dtoFile) {
      return createFallbackObject(fieldName);
    }

    const dtoText = await fs.readFile(dtoFile.fsPath, 'utf8');
    const fields = parseJavaFields(dtoText);
    if (fields.length === 0) {
      return createFallbackObject(fieldName);
    }

    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const normalized = normalizeJavaType(field.type);
      if (isCollectionType(normalized)) {
        const elementType = extractCollectionElementType(field.type);
        payload[field.name] = elementType
          ? [await buildBodyPayloadFromType(document, elementType, field.name, visitedTypes)]
          : [];
        continue;
      }
      if (isScalarType(normalized)) {
        payload[field.name] = createSampleScalar(normalized, field.name);
        continue;
      }
      payload[field.name] = await buildBodyPayloadFromType(document, normalized, field.name, visitedTypes);
    }
    return payload;
  } finally {
    visitedTypes.delete(simpleType);
  }
}

function parseJavaFields(javaText: string): Array<{ type: string; name: string }> {
  const regex =
    /^\s*(?:private|protected|public)\s+(?!static\b)(?!final\b)([A-Za-z0-9_<>\[\].?, ]+)\s+([A-Za-z0-9_]+)\s*(?:=[^;]*)?;/gm;
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
  const regex =
    /^\s*(?:private|protected|public)\s+(?!static\b)(?!final\b)([A-Za-z0-9_<>\[\].?, ]+)\s+([A-Za-z0-9_]+)\s*(?:=[^;]*)?;/gm;
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

function createSampleScalar(typeName: string, fieldName: string): unknown {
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
  return (
    /^(List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|Map|HashMap|LinkedHashMap)\b/.test(simple) ||
    simple.endsWith('[]')
  );
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

function createFallbackObject(fieldName: string): Record<string, unknown> {
  return {
    id: createSampleScalar('String', 'id'),
    name: createSampleScalar('String', fieldName || 'name')
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

async function tryBuildBodyWithAI(
  document: vscode.TextDocument,
  bodyParam: MethodParam,
  localBody: unknown,
  methodName: string,
  settings: SpringHttpGeneratorConfig,
  extensionRootPath: string,
  log: Logger
): Promise<unknown> {
  if (!settings.aiEndpoint) {
    throw new Error('未配置 OpenAI Responses 接口地址，请设置 springHttpGenerator.aiEndpoint');
  }
  if (!settings.aiApiKey) {
    throw new Error('未配置 OpenAI API Key，请设置 springHttpGenerator.aiApiKey');
  }

  log('STEP', `开始 AI 参数补全(Responses): endpoint=${settings.aiEndpoint}, model=${settings.aiModel}`);
  const controllerText = await readSourceFileByPath(document.uri.fsPath);
  log('STEP', 'AI 参数流程: 开始读取测试数据池');
  const testDataPools = await loadTestDataPools(document, settings, extensionRootPath, log);
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
    logger: log,
    aiEndpoint: settings.aiEndpoint,
    aiApiKey: settings.aiApiKey,
    aiModel: settings.aiModel,
    reactSystemPrompt: settings.aiContextAgentPrompt,
    sqlSearchGlobs: settings.sqlSearchGlobs
  });
  log(
    'STEP',
    `AI 参数流程: 业务上下文采集完成, summary=${projectContext.summary}, contextLength=${projectContext.contextText.length}`
  );

  const prompt = [
    '根据 Java 字段和随机测试数据池生成最小化测试请求体。',
    '硬性规则:',
    '1) 仅返回 JSON，不要 markdown，不要解释。',
    '2) 只保留关键字段，字段数量尽量少（建议 3~6 个）。',
    '3) 字段名必须来自候选字段，绝对不要输出 aid 和 修改时间',
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
    `随机测试数据池(JSON): ${JSON.stringify(randomPoolSnapshot)}`,
    `Controller源码: ${controllerText}`,
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
