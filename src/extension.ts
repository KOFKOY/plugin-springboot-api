import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpringHttpGeneratorConfig } from './config';
import {
  collectMappingAnnotations,
  joinUrlPath,
  parseClassBasePath,
  parseClassName,
  parseMethodSignatureAfter,
  parseRequestInfoFromAnnotation
} from './http-request-parser';
import { appendHttpRequestSection, resolveTargetHttpFilePath } from './http-file-writer';
import { initLogger, log, logError } from './logger';
import { prepareRequestPayload } from './request-payload';

let extensionRootPath = '';

export function activate(context: vscode.ExtensionContext): void {
  extensionRootPath = context.extensionPath || '';
  initLogger(context);
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
  const runningStatus = vscode.window.setStatusBarMessage('$(sync~spin) http文件生成中');
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('未找到激活中的编辑器');
    }
    log('STEP', `当前文件: ${editor.document.fileName}`);

    const document = editor.document;
    if (document.languageId !== 'java') {
      throw new Error('当前文件不是 Java 文件');
    }

    const settings = SpringHttpGeneratorConfig.load(document.uri);
    log('STEP', `配置读取完成: baseUrl=${settings.baseUrl}, authHeaderKey=${settings.tokenVarName}`);
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
      settings,
      {
        extensionRootPath,
        logger: log
      }
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
    vscode.window.setStatusBarMessage('$(check) http文件生成成功', 3000);
  } finally {
    runningStatus.dispose();
  }
}
