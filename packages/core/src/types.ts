/** A single finding from any analyzer */
export interface Issue {
  id: string;
  category:
    | 'dead-end'
    | 'orphan'
    | 'back-nav'
    | 'touch-target'
    | 'overlap'
    | 'scroll'
    | 'overlay-trap'
    | 'incomplete-connection'
    | 'vision';
  severity: 'critical' | 'high' | 'medium' | 'low';
  screenId: string;
  screenName: string;
  nodeId?: string;
  message: string;
  evidence: Record<string, unknown>;
}

/** Common interface for all analyzers */
export interface Analyzer {
  name: string;
  analyze(file: FigmaFile, options: AnalyzerOptions): Promise<Issue[]>;
}

export interface AnalyzerOptions {
  /** Minimum touch target size in px (default: 44) */
  minTouchTarget?: number;
  /** Pages to analyze (default: all) */
  pageIds?: string[];
  /** Skip specific checks */
  skip?: string[];
}

/** Simplified Figma file structure with prototype data */
export interface FigmaFile {
  name: string;
  lastModified: string;
  version: string;
  document: FigmaNode;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  /** Prototype interactions (REST API field, since Sep 2024) */
  interactions?: Interaction[];
  /** Flow starting points (on CANVAS nodes only) */
  flowStartingPoints?: FlowStartingPoint[];
  /** Bounding box for spatial analysis */
  absoluteBoundingBox?: BoundingBox;
  /** Scroll/overflow behavior */
  overflowDirection?: 'NONE' | 'HORIZONTAL_SCROLLING' | 'VERTICAL_SCROLLING' | 'HORIZONTAL_AND_VERTICAL_SCROLLING';
  /** Whether frame clips content */
  clipsContent?: boolean;
}

export interface Interaction {
  trigger: { type: string };
  actions: InteractionAction[];
}

export interface InteractionAction {
  type: 'NODE' | 'BACK' | 'CLOSE' | 'URL' | 'SET_VARIABLE' | 'SET_VARIABLE_MODE' | 'CONDITIONAL' | 'UPDATE_MEDIA_RUNTIME';
  destinationId?: string;
  navigation?: 'NAVIGATE' | 'OVERLAY' | 'SWAP' | 'SCROLL_TO' | 'CHANGE_TO';
  transition?: { type: string; duration: number };
  preserveScrollPosition?: boolean;
  /** For CONDITIONAL actions */
  conditionalBlocks?: Array<{ condition: unknown; actions: InteractionAction[] }>;
}

export interface FlowStartingPoint {
  nodeId: string;
  name: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Directed graph representation of prototype navigation */
export interface PrototypeGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge[]>;
  startingPoints: FlowStartingPoint[];
}

export interface GraphNode {
  id: string;
  name: string;
  pageId: string;
  type: string;
  hasInteractions: boolean;
  hasBackAction: boolean;
  hasCloseAction: boolean;
  /** Number of interactions with destinationId: null (incomplete prototyping) */
  nullDestinationCount: number;
  /** Whether screen name suggests it's archived/deprecated */
  isArchived: boolean;
  boundingBox?: BoundingBox;
}

export interface GraphEdge {
  sourceNodeId: string;
  sourceNodeName: string;
  destinationId: string;
  navigation: string;
  trigger: string;
  actionType: string;
}

export interface ScanResult {
  file: { name: string; key: string; lastModified: string };
  graph: PrototypeGraph;
  issues: Issue[];
  summary: ScanStats;
  duration: number;
  timestamp: string;
  skippedChecks: string[];
}

export interface ScanStats {
  total: number;
  bySeverity: Record<Issue['severity'], number>;
  byCategory: Record<Issue['category'], number>;
  screens: { total: number; withIssues: number };
}
