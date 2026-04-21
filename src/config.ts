import * as vscode from 'vscode';
// 文件作用: 读取并合并 VSCode 扩展配置，提供统一配置对象。

interface SpringHttpGeneratorConfigData {
  baseUrl: string;
  tokenVarName: string;
  tokenValue: string;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  aiContextAgentPrompt: string;
  sqlSearchGlobs: string[];
  testDataFile: string;
  aiSystemPrompt: string;
}

const DEFAULT_AI_CONTEXT_AGENT_PROMPT =
  '你是代码检索智能体，采用 ReAct（Reason + Act）工作流。按 Controller -> Service -> Mapper -> SQL 顺序定位上下文，只保留最关键的一条链路：最多一个 Service、最多一个 Mapper、最多一个 SQL。只输出结构化 JSON，最终仅返回 Service 与 SQL 的有效证据，不返回 Mapper 内容本体。优先结合方法体调用、字段注入与构造注入推断 Service。';

const DEFAULT_AI_SYSTEM_PROMPT =
  '你是接口测试参数生成助手。仅输出 JSON 对象，且仅保留关键字段，禁止输出 aid 和 修改时间。';

const DEFAULT_CONFIG: SpringHttpGeneratorConfigData = {
  baseUrl: 'http://localhost:8080',
  tokenVarName: 'Authorization',
  tokenValue: '',
  aiEndpoint: 'https://api.openai.com/v1/responses',
  aiApiKey: '',
  aiModel: 'gpt-5.1-codex-max',
  aiContextAgentPrompt: DEFAULT_AI_CONTEXT_AGENT_PROMPT,
  sqlSearchGlobs: [
    '**/src/main/resources/sql/**/*.{md,sql,xml}',
    '**/src/main/resources/**/*Mapper.xml',
    '**/*.{md,sql,xml}'
  ],
  testDataFile: '',
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isNonEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function mergeByNonEmpty(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isNonEmptyValue(value)) {
      result[key] = value;
    }
  }
  return result;
}

function readString(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key];
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return fallback.trim();
  }
  return String(value).trim();
}

function readStringArray(source: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const value = source[key];
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[\r\n,;]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return fallback.slice();
}

function resolveMergedRawConfig(scope?: vscode.ConfigurationScope): Record<string, unknown> {
  const inspect = vscode.workspace
    .getConfiguration(undefined, scope)
    .inspect<Record<string, unknown>>('springHttpGenerator');
  const globalConfig = toRecord(inspect?.globalValue);
  const workspaceConfig = toRecord(inspect?.workspaceValue);
  const workspaceFolderConfig = toRecord(inspect?.workspaceFolderValue);

  // 本地项目优先级：workspaceFolder > workspace，且仅“非空值”允许覆盖。
  const localConfig = mergeByNonEmpty(workspaceConfig, workspaceFolderConfig);

  // 与全局合并时，仍采用“本地非空覆盖全局”规则。
  return mergeByNonEmpty(globalConfig, localConfig);
}

export class SpringHttpGeneratorConfig implements SpringHttpGeneratorConfigData {
  baseUrl: string;
  tokenVarName: string;
  tokenValue: string;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  aiContextAgentPrompt: string;
  sqlSearchGlobs: string[];
  testDataFile: string;
  aiSystemPrompt: string;

  constructor(rawConfig: Record<string, unknown> = {}) {
    this.baseUrl = readString(rawConfig, 'baseUrl', DEFAULT_CONFIG.baseUrl) || DEFAULT_CONFIG.baseUrl;
    this.tokenVarName = readString(rawConfig, 'tokenVarName', DEFAULT_CONFIG.tokenVarName) || DEFAULT_CONFIG.tokenVarName;
    this.tokenValue = readString(rawConfig, 'tokenValue', DEFAULT_CONFIG.tokenValue);
    this.aiEndpoint = readString(rawConfig, 'aiEndpoint', DEFAULT_CONFIG.aiEndpoint) || DEFAULT_CONFIG.aiEndpoint;
    this.aiApiKey = readString(rawConfig, 'aiApiKey', DEFAULT_CONFIG.aiApiKey);
    this.aiModel = readString(rawConfig, 'aiModel', DEFAULT_CONFIG.aiModel) || DEFAULT_CONFIG.aiModel;
    this.aiContextAgentPrompt =
      readString(rawConfig, 'aiContextAgentPrompt', DEFAULT_CONFIG.aiContextAgentPrompt) ||
      DEFAULT_CONFIG.aiContextAgentPrompt;
    this.sqlSearchGlobs =
      readStringArray(rawConfig, 'sqlSearchGlobs', DEFAULT_CONFIG.sqlSearchGlobs) || DEFAULT_CONFIG.sqlSearchGlobs;
    this.testDataFile = readString(rawConfig, 'testDataFile', DEFAULT_CONFIG.testDataFile);
    this.aiSystemPrompt =
      readString(rawConfig, 'aiSystemPrompt', DEFAULT_CONFIG.aiSystemPrompt) || DEFAULT_CONFIG.aiSystemPrompt;
  }

  static load(scope?: vscode.ConfigurationScope): SpringHttpGeneratorConfig {
    return new SpringHttpGeneratorConfig(resolveMergedRawConfig(scope));
  }
}
