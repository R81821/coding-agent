# 小灰嘎风车步行动画

Generated with the built-in `imagegen` tool using the character reference attached
to the user's “生成白色背景图片” conversation. The user confirmed a rotating pinwheel.

- Asset: `xiaohuiga-pinwheel-walk.png`, RGBA, 1536 × 1024.
- Frames: six 512 × 512 cells, three columns and two rows, in reading order.
- Playback: `../ui/loading-state.css`, 900 ms loop, displayed at 112 × 112.
- Reduced motion: display the first frame without animation.
- Preview: from `apps/desktop`, run `node --import tsx test-fixtures/loading-preview.ts`.

## Generation prompt

Create a production-ready transparent PNG sprite sheet for a small desktop chat loading animation, based closely on the attached reference character. The reference is a smiling chibi black-haired girl in a round gray duck costume: duck hood with white eyes and yellow beak, rosy cheeks, blue triangular scarf, light gray belly, yellow webbed feet, holding a pastel yellow/pink/blue PINWHEEL on a white stick to her left. Preserve these distinctive features and charming chunky pixel-art outlines. Do not include the pink fabric background, photography, watermark or any text. Output ONE sprite sheet, landscape 1536x1024, EXACTLY 3 columns by 2 rows of six equal 512x512 cells. No visible grid lines, no labels, no gutters, truly transparent alpha background. Each cell contains the same complete character and whole pinwheel at identical scale and same anchored center with ample transparent margins, never overlapping cell boundaries. Character with pinwheel fits within the middle 400x430 area of every cell. Six sequential frames read left-to-right across top row then bottom row; make a seamless cheerful walking-in-place loop: alternate stepping left and right webbed feet, small body bounce and arm sway, with the pinwheel blades turning clockwise through six successive angles. Keep the face, costume, pinwheel center, stick length and overall composition consistent across all six frames. Pose is three-quarter frontal like reference, eyes happily closed and mouth smiling. Crisp clean pixel sprite artwork suited to display around 112px square, no blur, no photo texture, no ground, no shadow, no decoration. The actual animation will be made by code from these six cells, so strict grid alignment is essential.
