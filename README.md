# Space Cats 🐱🚀

A vertical-scrolling space shooter where cats battle it out among the stars.
It's a single `index.html` with no dependencies.

## Play

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | WASD / Arrow keys | Drag |
| Fire | Space (or Z / J) | Auto while dragging |
| Pause | P / Esc | — |
| Mute | M | — |

## Gameplay

You pilot an orange tabby in a bubble-helmet starfighter, firing laser-pointer
bolts at waves of rival alien cats in flying saucers.

**Enemies**
- **Kitten**: weak and drifts down
- **Zoomie**: fast and zig-zags
- **Tabby**: slows down and spits hairballs at you
- **Tank Cat**: heavily armoured, fires 3-way hairballs
- **Mega Tom** (every 5th wave): a crowned boss with three attack patterns that enrages at low HP

**Power-ups** (dropped by defeated cats)
- 🐟 **Fish**: restores 2 health
- 🧶 **Yarn**: 5-way spread shot
- 🌿 **Catnip**: rapid fire
- 📦 **Box**: absorbs one hit ("if I fits, I sits")

You have 5 health paws and 3 lives. Your high score is saved in the browser.
