import { supabase } from '@/lib/supabase'
import type { BoardData, Pt } from '@/lib/board'
import { toError } from './errors'

/** 'inbox' or a canvas id — the key positions are saved under. */
export const boardKey = (canvasId: string | null) => canvasId ?? 'inbox'

export async function getBoard(canvasId: string | null, showDone: boolean): Promise<BoardData> {
  const { data, error } = await supabase.rpc('board_data', { p_canvas: canvasId, p_done: showDone })
  if (error) throw toError(error)
  return data as BoardData
}

export async function savePositions(board: string, spots: { task_id: string; x: number; y: number }[]): Promise<void> {
  if (!spots.length) return
  const rows = spots.map((s) => ({ board, task_id: s.task_id, x: Math.round(s.x), y: Math.round(s.y) }))
  const { error } = await supabase.from('board_positions').upsert(rows, { onConflict: 'user_id,board,task_id' })
  if (error) throw toError(error)
}

export type { Pt }
