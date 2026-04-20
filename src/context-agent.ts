import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXCLUDE_GLOB = '**/{target,build,out,node_modules,.git,dist}/**';
const DEFAULT_REACT_PROMPT =
  '你是代码检索智能体，采用 ReAct（Reason + Act）范式。按 Controller -> Service -> Mapper -> SQL 顺序进行定位。每一层只保留最关键的一条链路：最多 1 个 Service、最多 1 个 Mapper、最多 1 个 SQL 资源。必须只输出 JSON，不允许 markdown 和解释。最终目标是提取对生成接口测试参数有价值的 Service 与 SQL 证据，忽略 Mapper 样板内容。';

type ContextLogLevel = 'INFO' | 'STEP' | 'ERROR';
type ContextLogger = (level: ContextLogLevel, message: string) => void;

interface ContextAgentOptions {
  document: vscode.TextDocument;
  methodName: string;
  projectStructureHint?: string;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  reactSystemPrompt?: string;
  logger?: ContextLogger;
}

interface ContextAgentResult {
  contextText: string;
  summary: string;
}

interface InjectionInfo {
  name: string;
  type: string;
  inject_mode?: string;
}

interface ServiceCallInfo {
  service_var: string;
  service_type: string;
  service_method: string;
  call_expression?: string;
  reason?: string;
}

interface MapperCallInfo {
  mapper_type: string;
  mapper_method: string;
  reason?: string;
}

interface ServiceReactResult {
  service_method_snippet?: string;
  mapper_calls?: MapperCallInfo[];
}

interface ReActStepInput {
  stageName: string;
  logger?: ContextLogger;
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
}

export async function collectProjectContextForPrompt(
  options: ContextAgentOptions
): Promise<ContextAgentResult> {
  const {
    document,
    methodName,
    projectStructureHint = '',
    aiEndpoint,
    aiApiKey,
    aiModel,
    reactSystemPrompt = '',
    logger
  } = options || ({} as ContextAgentOptions);

  const logStep = (message: string): void => {
    logger?.('STEP', `[AI上下文] ${message}`);
  };
  const logError = (message: string): void => {
    logger?.('ERROR', `[AI上下文] ${message}`);
  };

  if (!document || !methodName) {
    logStep('缺少 document 或 methodName，未采集上下文');
    return { contextText: '', summary: '缺少 document 或 methodName，未采集业务上下文' };
  }
  if (!aiEndpoint || !aiApiKey || !aiModel) {
    throw new Error('AI 上下文采集缺少 endpoint/apiKey/model 配置');
  }

  const systemPrompt = reactSystemPrompt.trim() || DEFAULT_REACT_PROMPT;
  const currentDir = path.dirname(document.uri.fsPath).toLowerCase();

  try {
    const controllerText = document.getText();
    logStep(`开始 ReAct 上下文采集: method=${methodName}, file=${document.fileName}`);

    const controllerResult = await runReActStep({
      stageName: 'Controller->Service',
      logger,
      endpoint: aiEndpoint,
      apiKey: aiApiKey,
      model: aiModel,
      systemPrompt,
      prompt: buildControllerStagePrompt({
        controllerFile: document.fileName,
        methodName,
        projectStructureHint,
        controllerText
      })
    });

    const injections = normalizeInjections(controllerResult.injections);
    const serviceCalls = normalizeServiceCalls(controllerResult.service_calls, injections);
    if (serviceCalls.length === 0) {
      logStep('Controller 阶段未识别到 Service 调用');
      return {
        contextText: `[AI上下文]\nController 未识别到 Service 调用。\n目标方法: ${methodName}`,
        summary: '未识别 Service 调用'
      };
    }
    logStep(`Controller 阶段完成: serviceCallCount=${serviceCalls.length}`);

    const controllerImports = parseImports(controllerText);
    const serviceSections: string[] = [];
    const sqlSections: string[] = [];
    const primaryServiceCall = pickPrimaryServiceCall(serviceCalls);
    if (!primaryServiceCall) {
      logStep('Controller 阶段未选出关键 Service 调用');
      return {
        contextText: `[AI上下文]\nController 未选出关键 Service 调用。\n目标方法: ${methodName}`,
        summary: '未选出关键 Service 调用'
      };
    }
    if (serviceCalls.length > 1) {
      logStep(`Controller 阶段仅保留最关键 Service: total=${serviceCalls.length}, selected=1`);
    }

    const serviceType = baseJavaTypeName(primaryServiceCall.service_type);
    if (!serviceType || !primaryServiceCall.service_method) {
      logStep(`关键 Service 调用项无效: ${JSON.stringify(primaryServiceCall)}`);
      return {
        contextText: `[AI上下文]\n关键 Service 调用项无效。\n目标方法: ${methodName}`,
        summary: '关键 Service 调用项无效'
      };
    }

    logStep(
      `追踪关键 Service: var=${primaryServiceCall.service_var}, type=${serviceType}, method=${primaryServiceCall.service_method}`
    );
    const serviceImport = controllerImports[serviceType];
    const serviceInterface = await findJavaTypeFile(serviceType, document, serviceImport, 120);
    const serviceImpl = await findServiceImplFile(serviceType, serviceImport, document, 240);
    const serviceFile = serviceImpl || serviceInterface;

    if (!serviceFile) {
      logStep(`未找到 Service 文件: ${serviceType}`);
    } else {
      const serviceText = await fs.readFile(serviceFile.fsPath, 'utf8');
      logStep(`命中 Service 文件: ${serviceFile.fsPath}`);
      const serviceStageResult = (await runReActStep({
        stageName: 'Service->Mapper',
        logger,
        endpoint: aiEndpoint,
        apiKey: aiApiKey,
        model: aiModel,
        systemPrompt,
        prompt: buildServiceStagePrompt({
          serviceType,
          serviceMethod: primaryServiceCall.service_method,
          serviceCallExpr: primaryServiceCall.call_expression || '',
          serviceFilePath: serviceFile.fsPath,
          serviceSource: serviceText,
          projectStructureHint
        })
      })) as ServiceReactResult;

      const serviceSnippet = String(serviceStageResult.service_method_snippet || '').trim();
      serviceSections.push(
        [
          `[Service证据]`,
          `类型: ${serviceType}`,
          `方法: ${primaryServiceCall.service_method}`,
          `文件: ${serviceFile.fsPath}`,
          serviceSnippet ? trimText(serviceSnippet, 8000) : trimText(serviceText, 5000)
        ].join('\n')
      );

      const mapperCalls = normalizeMapperCalls(serviceStageResult.mapper_calls);
      logStep(`Service 阶段完成: mapperCallCount=${mapperCalls.length}`);

      const primaryMapperCall = pickPrimaryMapperCall(mapperCalls);
      if (primaryMapperCall) {
        if (mapperCalls.length > 1) {
          logStep(`Service 阶段仅保留最关键 Mapper: total=${mapperCalls.length}, selected=1`);
        }
        const mapperType = baseJavaTypeName(primaryMapperCall.mapper_type);
        if (mapperType) {
          logStep(`追踪关键 Mapper: type=${mapperType}, method=${primaryMapperCall.mapper_method || 'N/A'}`);
          const serviceImports = parseImports(serviceText);
          const mapperImport = serviceImports[mapperType];
          const mapperFile = await findJavaTypeFile(mapperType, document, mapperImport, 160);
          if (!mapperFile) {
            logStep(`未找到 Mapper 文件: ${mapperType}`);
          } else {
            const mapperText = await fs.readFile(mapperFile.fsPath, 'utf8');
            const mapperStageResult = await runReActStep({
              stageName: 'Mapper->SQL',
              logger,
              endpoint: aiEndpoint,
              apiKey: aiApiKey,
              model: aiModel,
              systemPrompt,
              prompt: buildMapperStagePrompt({
                mapperType,
                mapperMethod: primaryMapperCall.mapper_method,
                mapperFilePath: mapperFile.fsPath,
                mapperSource: mapperText,
                projectStructureHint
              })
            });

            const sqlResources = normalizeStringArray(mapperStageResult.sql_resources);
            logStep(`Mapper 阶段完成: sqlResourceCount=${sqlResources.length}`);
            const primarySqlResource = pickPrimaryString(sqlResources);
            if (primarySqlResource) {
              if (sqlResources.length > 1) {
                logStep(`Mapper 阶段仅保留最关键 SQL 资源: total=${sqlResources.length}, selected=1`);
              }
              const normalized = primarySqlResource.trim();
              const sqlFile = await findSqlFileByResource(normalized, currentDir);
              if (!sqlFile) {
                logStep(`未找到 SQL 文件: resource=${normalized}`);
              } else {
                logStep(`命中 SQL 文件: resource=${normalized}, file=${sqlFile.fsPath}`);
                const sqlText = await fs.readFile(sqlFile.fsPath, 'utf8');
                const targetSql = extractBeetlSqlByMethod(sqlText, primaryMapperCall.mapper_method);
                sqlSections.push(
                  [
                    '[SQL证据]',
                    `资源名: ${normalized}`,
                    `文件: ${sqlFile.fsPath}`,
                    `方法: ${primaryMapperCall.mapper_method}`,
                    targetSql
                      ? trimText(targetSql, 9000)
                      : `未在 SQL 资源中找到方法 ${primaryMapperCall.mapper_method} 的实现`
                  ].join('\n')
                );
              }
            }
          }
        }
      }
    }

    if (serviceSections.length === 0 && sqlSections.length === 0) {
      logStep('ReAct 采集完成，但未形成有效 Service/SQL 证据');
      return {
        contextText: `[AI上下文]\n未找到可用 Service/SQL 证据。\n目标方法: ${methodName}`,
        summary: '未形成有效 Service/SQL 证据'
      };
    }

    const contextText = trimText(
      [
        '[ReAct上下文采集结果]',
        `Controller文件: ${document.fileName}`,
        `目标方法: ${methodName}`,
        projectStructureHint ? `[项目结构提示]\n${projectStructureHint}` : '',
        serviceSections.join('\n\n'),
        sqlSections.join('\n\n')
      ]
        .filter((item) => item)
        .join('\n\n'),
      26000
    );

    const summary = `Service证据 ${serviceSections.length} 段, SQL证据 ${sqlSections.length} 段`;
    logStep(`ReAct 上下文采集结束: ${summary}`);
    return {
      contextText,
      summary
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
    logError(`上下文采集失败: ${message}`);
    return {
      contextText: `[业务上下文采集失败]\n${message}`,
      summary: `上下文采集失败: ${message}`
    };
  }
}

async function runReActStep(input: ReActStepInput): Promise<Record<string, unknown>> {
  const { stageName, logger, endpoint, apiKey, model, systemPrompt, prompt } = input;
  logger?.('STEP', `[AI上下文][${stageName}] 请求发送中`);

  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }]
      }
    ]
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  logger?.('STEP', `[AI上下文][${stageName}] 请求返回: status=${response.status}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[${stageName}] OpenAI Responses 请求失败: HTTP ${response.status}, body=${body}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const outputText = extractResponsesOutputText(result);
  logger?.('STEP', `[AI上下文][${stageName}] 响应文本长度=${outputText.length}`);
  const parsed = parseFirstJson(outputText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[${stageName}] 模型输出不是有效 JSON 对象: ${outputText}`);
  }
  return parsed as Record<string, unknown>;
}

function buildControllerStagePrompt(input: {
  controllerFile: string;
  methodName: string;
  projectStructureHint: string;
  controllerText: string;
}): string {
  const { controllerFile, methodName, projectStructureHint, controllerText } = input;
  return [
    '阶段目标: Controller -> Service。',
    '要求:',
    '1) 必须解析目标方法 methodName 对应的方法体。',
    '2) 必须解析 Controller 中全部注入信息，包含字段注入和构造注入。',
    '3) 从方法体里识别出真正参与调用链的 Service 调用（例如 xxxService.queryByPage(...)）。',
    '4) 仅保留最关键的一个 Service 调用，service_calls 最多返回 1 项。',
    '5) 输出严格 JSON 对象。',
    'JSON 结构:',
    '{',
    '  "target_method": "string",',
    '  "method_body": "string",',
    '  "injections": [{"name":"string","type":"string","inject_mode":"field|constructor|other"}],',
    '  "service_calls": [{"service_var":"string","service_type":"string","service_method":"string","call_expression":"string","reason":"string"}]',
    '}',
    `controller_file: ${controllerFile}`,
    `method_name: ${methodName}`,
    projectStructureHint ? `project_structure_hint: ${projectStructureHint}` : '',
    `controller_source:\n${trimText(controllerText, 20000)}`
  ]
    .filter((item) => item)
    .join('\n');
}

function buildServiceStagePrompt(input: {
  serviceType: string;
  serviceMethod: string;
  serviceCallExpr: string;
  serviceFilePath: string;
  serviceSource: string;
  projectStructureHint: string;
}): string {
  const { serviceType, serviceMethod, serviceCallExpr, serviceFilePath, serviceSource, projectStructureHint } = input;
  return [
    '阶段目标: Service -> Mapper。',
    '要求:',
    '1) 定位 serviceMethod 在 serviceSource 中的核心实现片段（优先实现类）。',
    '2) 从该实现片段中提取 Mapper 调用（mapperType + mapperMethod）。',
    '3) 仅保留最关键的一个 Mapper 调用，mapper_calls 最多返回 1 项。',
    '4) 只输出 JSON 对象，不输出 markdown。',
    'JSON 结构:',
    '{',
    '  "service_method_snippet": "string",',
    '  "mapper_calls": [{"mapper_type":"string","mapper_method":"string","reason":"string"}]',
    '}',
    `service_type: ${serviceType}`,
    `service_method: ${serviceMethod}`,
    serviceCallExpr ? `service_call_expression_from_controller: ${serviceCallExpr}` : '',
    `service_file: ${serviceFilePath}`,
    projectStructureHint ? `project_structure_hint: ${projectStructureHint}` : '',
    `service_source:\n${trimText(serviceSource, 26000)}`
  ]
    .filter((item) => item)
    .join('\n');
}

function buildMapperStagePrompt(input: {
  mapperType: string;
  mapperMethod: string;
  mapperFilePath: string;
  mapperSource: string;
  projectStructureHint: string;
}): string {
  const { mapperType, mapperMethod, mapperFilePath, mapperSource, projectStructureHint } = input;
  return [
    '阶段目标: Mapper -> SQL 资源名。',
    '要求:',
    '1) 从 mapperSource 中提取 SQL 资源名（如 @SqlResource("mcSkuInfo") -> mcSkuInfo）。',
    '2) 同时允许从命名或注释中推断候选 SQL 资源名。',
    '3) 仅保留最关键的一个 SQL 资源名，sql_resources 最多返回 1 项。',
    '4) 不输出 Mapper 原文。',
    '5) 仅输出 JSON 对象。',
    'JSON 结构:',
    '{',
    '  "sql_resources": ["string"],',
    '  "reason": "string"',
    '}',
    `mapper_type: ${mapperType}`,
    mapperMethod ? `mapper_method: ${mapperMethod}` : '',
    `mapper_file: ${mapperFilePath}`,
    projectStructureHint ? `project_structure_hint: ${projectStructureHint}` : '',
    `mapper_source:\n${trimText(mapperSource, 12000)}`
  ]
    .filter((item) => item)
    .join('\n');
}

function normalizeInjections(raw: unknown): InjectionInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: InjectionInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const data = item as Record<string, unknown>;
    const name = String(data.name || '').trim();
    const type = String(data.type || '').trim();
    if (!name || !type) {
      continue;
    }
    result.push({
      name,
      type,
      inject_mode: String(data.inject_mode || '').trim() || 'other'
    });
  }
  return result;
}

function normalizeServiceCalls(raw: unknown, injections: InjectionInfo[]): ServiceCallInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const injectionTypeByName = new Map<string, string>();
  for (const item of injections) {
    injectionTypeByName.set(item.name, item.type);
  }

  const dedupe = new Set<string>();
  const result: ServiceCallInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const data = item as Record<string, unknown>;
    const serviceVar = String(data.service_var || '').trim();
    const serviceMethod = String(data.service_method || '').trim();
    const serviceType = String(data.service_type || injectionTypeByName.get(serviceVar) || '').trim();
    if (!serviceVar || !serviceMethod || !serviceType) {
      continue;
    }
    const key = `${serviceVar}::${serviceType}::${serviceMethod}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    result.push({
      service_var: serviceVar,
      service_type: serviceType,
      service_method: serviceMethod,
      call_expression: String(data.call_expression || '').trim(),
      reason: String(data.reason || '').trim()
    });
  }
  return result;
}

function normalizeMapperCalls(raw: unknown): MapperCallInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const dedupe = new Set<string>();
  const result: MapperCallInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const data = item as Record<string, unknown>;
    const mapperType = String(data.mapper_type || '').trim();
    const mapperMethod = String(data.mapper_method || '').trim();
    if (!mapperType) {
      continue;
    }
    const key = `${mapperType}::${mapperMethod}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    result.push({
      mapper_type: mapperType,
      mapper_method: mapperMethod,
      reason: String(data.reason || '').trim()
    });
  }
  return result;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const text = String(item || '').trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function pickPrimaryServiceCall(items: ServiceCallInfo[]): ServiceCallInfo | undefined {
  return items[0];
}

function pickPrimaryMapperCall(items: MapperCallInfo[]): MapperCallInfo | undefined {
  return items[0];
}

function pickPrimaryString(items: string[]): string | undefined {
  return items[0];
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
    const byImport = candidates.find((item) =>
      normalizePath(item.fsPath).endsWith(normalizePath(expected))
    );
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

async function findSqlFileByResource(
  resourceName: string,
  currentDir: string
): Promise<vscode.Uri | undefined> {
  const safeName = resourceName.trim();
  if (!safeName) {
    return undefined;
  }

  const directCandidates = await vscode.workspace.findFiles(
    `**/${safeName}.md`,
    EXCLUDE_GLOB,
    200
  );
  if (directCandidates.length === 0) {
    return undefined;
  }
  if (directCandidates.length === 1) {
    return directCandidates[0];
  }

  const preferred = directCandidates.find((item) =>
    normalizePath(item.fsPath).includes('/src/main/resources/sql/')
  );
  if (preferred) {
    return preferred;
  }

  return directCandidates
    .slice()
    .sort((a, b) => {
      const aScore = commonPrefixLength(currentDir, path.dirname(a.fsPath).toLowerCase());
      const bScore = commonPrefixLength(currentDir, path.dirname(b.fsPath).toLowerCase());
      return bScore - aScore;
    })[0];
}

function parseImports(javaText: string): Record<string, string> {
  const imports: Record<string, string> = {};
  const regex = /^\s*import\s+([a-zA-Z0-9_.]+)\s*;/gm;
  let match: RegExpExecArray | null = regex.exec(javaText);
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

function parseFirstJson(text: string): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    // ignore
  }

  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const candidate = text.slice(objStart, objEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore
    }
  }

  return undefined;
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

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
