export type ProviderId =
  | 'deepseek'
  | 'kimi'
  | 'dashscope'
  | 'zhipu'
  | 'doubao'
  | 'minimax'
  | 'siliconflow'
  | 'ollama'
  | 'custom';

export interface LlmConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  supportsJson: boolean;
  reasoningMode: 'off' | 'auto' | 'high';
}

export interface LlmPreset {
  id: ProviderId;
  name: string;
  baseUrl: string;
  model: string;
  supportsJson: boolean;
  apiKeyLabel: string;
  notes: string;
}

export interface ProjectSummary {
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  id: number;
  title: string;
  orderIndex: number;
  content: string;
  sourceFile: string;
  contentLength: number;
}

export interface CharacterNode {
  id: number;
  name: string;
  aliases: string[];
  summary: string;
  tags: string[];
  firstChapterId: number | null;
  status: 'candidate' | 'confirmed' | 'rejected';
}

export interface RelationshipEdge {
  id: number;
  sourceCharacterId: number;
  targetCharacterId: number;
  sourceName: string;
  targetName: string;
  type: string;
  status: 'candidate' | 'confirmed' | 'rejected';
  strength: number;
  summary: string;
  confidence: number;
}

export interface BondEvent {
  id: number;
  relationshipId: number;
  chapterId: number | null;
  chapterTitle: string | null;
  summary: string;
  evidence: string;
  orderIndex: number;
  status: 'candidate' | 'confirmed' | 'rejected';
}

export interface CharacterStatusEvent {
  id: number;
  characterId: number;
  characterName: string;
  chapterId: number | null;
  chapterTitle: string | null;
  status: 'active' | 'dead' | 'retired' | 'unused';
  evidence: string;
}

export interface CandidateExtraction {
  id: number;
  chapterId: number | null;
  chapterTitle: string | null;
  kind: 'character' | 'relationship' | 'event' | 'batch' | 'error';
  payload: unknown;
  status: 'pending' | 'confirmed' | 'rejected' | 'error';
  error: string;
  createdAt: string;
}

export interface GraphData {
  chapters: Chapter[];
  characters: CharacterNode[];
  relationships: RelationshipEdge[];
  events: BondEvent[];
  statusEvents: CharacterStatusEvent[];
  candidates: CandidateExtraction[];
}

export interface AnalyzeNovelResult {
  graph: GraphData;
  processed: number;
  remaining: number;
  errors: string[];
}

export interface ExtractionCharacter {
  name: string;
  aliases?: string[];
  summary?: string;
  tags?: string[];
  evidence?: string;
}

export interface ExtractionRelationship {
  source: string;
  target: string;
  type: string;
  summary: string;
  strength?: number;
  confidence?: number;
  evidence?: string;
  events?: Array<{
    summary: string;
    evidence: string;
  }>;
}

export interface ExtractionResult {
  characters: ExtractionCharacter[];
  relationships: ExtractionRelationship[];
  statusEvents?: Array<{
    character: string;
    status: 'active' | 'dead' | 'retired' | 'unused' | string;
    evidence?: string;
  }>;
}

export interface AppApi {
  createProject(name: string): Promise<ProjectSummary>;
  openProject(): Promise<ProjectSummary | null>;
  loadProject(projectPath: string): Promise<GraphData>;
  importNovel(projectPath: string): Promise<GraphData>;
  importNovelFromPath(projectPath: string, filePath: string): Promise<GraphData>;
  saveLlmConfig(projectPath: string | null, config: LlmConfig): Promise<LlmConfig>;
  loadLlmConfig(projectPath: string | null): Promise<LlmConfig>;
  testLlm(config: LlmConfig): Promise<{ ok: boolean; message: string }>;
  analyzeChapter(projectPath: string, chapterId: number): Promise<GraphData>;
  analyzeNovel(projectPath: string, upToChapterId?: number | null): Promise<AnalyzeNovelResult>;
  confirmCandidate(projectPath: string, candidateId: number): Promise<GraphData>;
  rejectCandidate(projectPath: string, candidateId: number): Promise<GraphData>;
  updateCharacter(projectPath: string, character: CharacterNode): Promise<GraphData>;
  updateRelationship(projectPath: string, relationship: RelationshipEdge): Promise<GraphData>;
  exportGraph(projectPath: string): Promise<string>;
  getPresets(): Promise<LlmPreset[]>;
}
