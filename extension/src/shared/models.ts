export interface QuotedPostContext {
  canonicalUrl?: string;
  authorHandle?: string;
  text: string;
}

export interface PostContext {
  postId: string;
  canonicalUrl: string;
  authorDisplayName: string;
  authorHandle: string;
  text: string;
  quotedPost?: QuotedPostContext;
  mediaUrls: string[];
  outboundUrls: string[];
  capturedAt: string;
}

export type BuildStatus = "submitted" | "building" | "ready" | "failed";

export interface WeaverBuild {
  postId: string;
  postUrl: string;
  projectName: string;
  projectPath: string;
  threadId: string;
  turnId?: string;
  status: BuildStatus;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeaverSettings {
  endpoint: string;
  projectRoot: string | null;
  openOnCompletion: boolean;
}

export type ConnectionState =
  | { status: "online"; endpoint: string; protocolVersion?: string }
  | { status: "offline"; endpoint: string; errorSummary?: string };
