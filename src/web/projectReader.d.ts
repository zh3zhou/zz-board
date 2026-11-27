/** The browser and the standalone Node Skill share the same pure project/record projection. */
declare module '*skills/read-zz-board-project/scripts/note-view.mjs' {
  type Board = import('../shared/schema.js').BoardState;
  type Note = import('../shared/schema.js').CanvasNodeRecord;
  export function projectNoteScope(board: Board, projectKey: string, includeArchived?: boolean): {
    visibleNotes: Note[];
    relation(id: string): 'direct' | 'shared-direct' | 'indirect';
  };
  export function noteChecklist(body: string): {line:number; text:string; completed:boolean}[];
}
