/**
 * マトリクス展開と関連する純粋ヘルパ。
 * JobScheduler クラス本体から分離した stateless ユーティリティ群。
 */
import type {
  Job,
  MatrixContext,
  StrategyContext,
  Workflow,
} from "../workflow-models.ts";
import type { DependencyGraph } from "./dependency.ts";
import { buildMatrixJobId, expandMatrix } from "./matrix.ts";

// --- needsInput 正規化 ---

export function normalizeNeedsInput(needs: unknown): string[] {
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) {
    return needs.filter((need): need is string => typeof need === "string");
  }
  return [];
}

// --- 展開バジェット ---

/**
 * Workflow-wide expansion budget. SECURITY (DoS): the per-unit caps multiply —
 * the validator allows 1000 jobs and 1000 steps per job, and each job may expand
 * to 256 matrix combinations, so `jobs × matrix × steps` is ~2.5×10^8 step rows,
 * all materialized synchronously on the Worker event loop and then written to D1
 * one awaited INSERT at a time by `createWorkflowRun`. Nothing capped the
 * product. Both budgets are charged WHILE the expansion is built, so the
 * explosion is rejected instead of allocated.
 */
const MAX_EXPANDED_JOBS_PER_WORKFLOW = 256;
const MAX_EXPANDED_STEPS_PER_WORKFLOW = 10000;

/** Thrown when a workflow's expansion exceeds the workflow-wide budget. */
export class WorkflowExpansionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowExpansionLimitError";
  }
}

// --- マトリクス展開されたジョブ ---

/**
 * スケジューラ内部で使用する展開済みジョブ記述子。
 * matrix を持たないジョブは一件の展開エントリとして扱う。
 */
export interface ExpandedJob {
  /** 展開後の一意な id (matrix がある場合は `${baseId}-${hash}` 形式) */
  id: string;
  /** 元ジョブ id */
  baseId: string;
  /** ジョブ定義 */
  job: Job;
  /** matrix context（matrix が無い場合は undefined） */
  matrix?: MatrixContext;
  /** strategy context（matrix が無い場合は undefined） */
  strategy?: StrategyContext;
}

/**
 * ワークフローを matrix 展開してスケジューラ内部で使う ExpandedJob の集合を返す。
 * - matrix が空なら元ジョブをそのまま 1 エントリにする
 * - matrix がある場合は組み合わせごとに `${baseId}-${hash}` を生成する
 */
export function buildExpandedJobs(workflow: Workflow): {
  jobs: Map<string, ExpandedJob>;
  expansionMap: Map<string, string[]>;
} {
  const jobs = new Map<string, ExpandedJob>();
  const expansionMap = new Map<string, string[]>();
  let totalSteps = 0;

  /** 展開エントリを 1 件バジェットに計上する（超過したら即中断）。 */
  const charge = (steps: number): void => {
    totalSteps += steps;
    if (jobs.size > MAX_EXPANDED_JOBS_PER_WORKFLOW) {
      throw new WorkflowExpansionLimitError(
        `Workflow expands to more than ${MAX_EXPANDED_JOBS_PER_WORKFLOW} jobs. ` +
          `Reduce the number of jobs or matrix combinations.`,
      );
    }
    if (totalSteps > MAX_EXPANDED_STEPS_PER_WORKFLOW) {
      throw new WorkflowExpansionLimitError(
        `Workflow expands to more than ${MAX_EXPANDED_STEPS_PER_WORKFLOW} steps. ` +
          `Reduce the number of steps or matrix combinations.`,
      );
    }
  };

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const expansions = expandMatrix(job.strategy);

    if (expansions.length === 0) {
      // 展開が無いジョブ (matrix 未指定 or 結果 0 件) → 単独エントリ
      jobs.set(jobId, {
        id: jobId,
        baseId: jobId,
        job,
      });
      charge(job.steps?.length ?? 0);
      expansionMap.set(jobId, [jobId]);
      continue;
    }

    // 展開されたエントリを全て追加
    const expandedIds: string[] = [];
    for (const expansion of expansions) {
      const expandedId = buildMatrixJobId(jobId, expansion.hash);
      // 万が一 hash 衝突した場合でも一意化するための suffix
      let uniqueId = expandedId;
      let counter = 1;
      while (jobs.has(uniqueId)) {
        uniqueId = `${expandedId}-${counter}`;
        counter += 1;
      }
      jobs.set(uniqueId, {
        id: uniqueId,
        baseId: jobId,
        job,
        matrix: expansion.matrix,
        strategy: expansion.strategy,
      });
      charge(job.steps?.length ?? 0);
      expandedIds.push(uniqueId);
    }
    expansionMap.set(jobId, expandedIds);
  }

  return { jobs, expansionMap };
}

/**
 * 展開後ジョブ用の DependencyGraph を構築する。
 * needs 参照は展開先 ID 全てに置き換える。
 */
export function buildExpandedDependencyGraph(
  expandedJobs: Map<string, ExpandedJob>,
  expansionMap: Map<string, string[]>,
): DependencyGraph {
  const nodes = new Set<string>();
  const edges = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, Set<string>>();

  for (const expanded of expandedJobs.values()) {
    nodes.add(expanded.id);
    edges.set(expanded.id, new Set());
    reverseEdges.set(expanded.id, new Set());
  }

  for (const expanded of expandedJobs.values()) {
    const needs = normalizeNeedsInput(expanded.job.needs);
    for (const need of needs) {
      const targets = expansionMap.get(need);
      if (!targets || targets.length === 0) {
        throw new Error(
          `Job "${expanded.baseId}" depends on unknown job "${need}"`,
        );
      }
      for (const target of targets) {
        if (!nodes.has(target)) {
          continue;
        }
        const expandedEdges = edges.get(expanded.id);
        const targetReverseEdges = reverseEdges.get(target);
        if (!expandedEdges || !targetReverseEdges) {
          throw new Error(
            `dependency graph invariant violated: missing edge map for "${expanded.id}" or "${target}"`,
          );
        }
        expandedEdges.add(target);
        targetReverseEdges.add(expanded.id);
      }
    }
  }

  return { nodes, edges, reverseEdges };
}
