import { AdminInsightBoardModel } from '../core/admin-api.service';

/**
 * Empty board so insight views render before the first insights response.
 */
export function emptyInsightBoard(scope = ''): AdminInsightBoardModel {
  return {
    scope,
    range: 'week',
    periodLabel: '7 ngày gần nhất',
    headline: 'Đang đọc tín hiệu khách hàng',
    questions: [],
    actions: [],
  };
}
