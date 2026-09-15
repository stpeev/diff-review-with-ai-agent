import * as vscode from 'vscode';
import type { Role } from '../../comment-store';

/** VS Code view for one persisted review comment. */
export class ReviewComment implements vscode.Comment {
  readonly id: number;
  readonly stableId: string;
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation;
  role: Role;
  contextValue: string;
  createdAt: string;
  timestamp: Date;

  constructor(body: string, role: Role, id: number, stableId: string, createdAt?: string) {
    this.id = id;
    this.stableId = stableId;
    this.body = body;
    this.role = role;
    this.mode = vscode.CommentMode.Preview;
    this.author = role === 'agent' ? { name: '🤖 Agent' } : { name: '👤 You' };
    this.contextValue = role === 'agent' ? 'agentComment' : 'userComment';
    this.createdAt = createdAt ?? new Date().toISOString();
    this.timestamp = new Date(this.createdAt);
  }
}
