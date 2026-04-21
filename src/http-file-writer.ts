import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpringHttpGeneratorConfig } from './config';
import { HttpMethod } from './http-request-parser';

const AUTH_HEADER_VALUE_VAR = 'authHeaderValue';

export async function resolveTargetHttpFilePath(document: vscode.TextDocument, className: string): Promise<string> {
  const projectRoot = getWorkspaceRootByDocument(document);
  const httpDir = path.join(projectRoot, 'http');
  await fs.mkdir(httpDir, { recursive: true });
  return path.join(httpDir, `${className}.http`);
}

export async function appendHttpRequestSection(
  filePath: string,
  className: string,
  methodName: string,
  httpMethod: HttpMethod,
  requestPath: string,
  contentType: string,
  bodyText: string,
  settings: SpringHttpGeneratorConfig
): Promise<void> {
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }

  if (exists) {
    await upsertAuthHeaderValueVariable(filePath, settings.tokenValue);
  }

  const header = exists ? '' : buildHttpFileHeader(settings.baseUrl, settings.tokenValue);
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

function getWorkspaceRootByDocument(document: vscode.TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  return workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.fileName);
}

async function upsertAuthHeaderValueVariable(filePath: string, tokenValue: string): Promise<void> {
  const raw = await fs.readFile(filePath, 'utf8');
  const escaped = escapeRegExp(AUTH_HEADER_VALUE_VAR);
  const lineRegex = new RegExp(`^@${escaped}\\s*=.*$`, 'm');
  const targetLine = `@${AUTH_HEADER_VALUE_VAR} = ${tokenValue}`;

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

function buildHttpFileHeader(baseUrl: string, tokenValue: string): string {
  return [
    `@baseUrl = ${baseUrl}`,
    `@${AUTH_HEADER_VALUE_VAR} = ${tokenValue || ''}`,
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
  authHeaderKey: string
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const normalizedAuthHeaderKey = authHeaderKey.trim() || 'Authorization';
  const lines: string[] = [
    `### ${now} ${className}.${methodName}`,
    `${httpMethod} {{baseUrl}}${requestPath}`,
    `Content-Type: ${contentType}`,
    `${normalizedAuthHeaderKey}: {{${AUTH_HEADER_VALUE_VAR}}}`,
    ''
  ];

  if (bodyText) {
    lines.push(bodyText);
  }
  lines.push('');
  return lines.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
