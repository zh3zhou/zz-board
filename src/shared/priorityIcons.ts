import { z } from 'zod';
import { mediaIdSchema } from './noteDocument.js';

export const priorityIconsSchema = z.object({
  style: z.enum(['ink-cat', 'ginger-cat', 'custom']),
  attentionImage: mediaIdSchema.nullable(),
  highImage: mediaIdSchema.nullable()
}).strict().refine(value => value.style !== 'custom' || Boolean(value.attentionImage && value.highImage), {
  message: '自定义图标需要关注和优先两张图片。'
});
export type PriorityIcons = z.infer<typeof priorityIconsSchema>;
export const defaultPriorityIcons: PriorityIcons = { style: 'ink-cat', attentionImage: null, highImage: null };
export const changePriorityIconsSchema = z.object({ previous: priorityIconsSchema, value: priorityIconsSchema }).strict();
export type ChangePriorityIcons = z.infer<typeof changePriorityIconsSchema>;
