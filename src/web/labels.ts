import type { BoardThread, BoardState } from '../shared/schema.js';

export function workLabel(value: BoardThread['workState']): string { return ({ in_progress:'进行中', stage_closed:'阶段收口', intentionally_closed:'主动收口', waiting_for_user:'等你行动', waiting_external:'等外部', needs_validation:'待验证', complete:'已完成', insufficient_evidence:'证据不足' } as const)[value]; }
export function actionLabel(value: BoardThread['humanAction']): string { return ({ test:'测试', review:'审阅', read_learn:'阅读/学习', decide:'决策', provide_material:'补材料', approve:'批准/授权', reply_continue:'回复继续', wait:'等待', none:'无需行动', uncertain:'不确定' } as const)[value]; }
export function strengthLabel(value: BoardState['todos'][number]['strength']): string { return value === 'blocking' ? '阻塞' : value === 'recommended' ? '推荐' : '可选'; }
export function confidenceLabel(value: BoardThread['confidence']): string { return value === 'high' ? '高置信' : value === 'medium' ? '中置信' : '低置信'; }
export function evidenceLabel(value: BoardState['projectBriefs'][number]['evidenceLevel']): string { return ({ deep_read:'已深读', summary_only:'仅摘要', file_verified:'文件核验', runtime_snapshot:'运行快照', none:'无证据' } as const)[value]; }
export function runtimeLabel(value: BoardThread['runtimeState'] | undefined): string { return ({ running:'运行中', idle:'空闲', interrupted:'已中断', error:'错误', unknown:'状态未知' } as const)[value || 'unknown']; }
