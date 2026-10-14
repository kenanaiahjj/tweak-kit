// One DialKit-style row for the UI Tweaks pane: label left, value right, a bar filling behind them.
// Drag across the row to set the value, ←/→ to step it (Shift: ×10), double-click to type one.
// Drawn by the surface; it posts { prop, value } (or { prop, edit: true }) to the mod's ui.message hook.
import type { ClientModule } from 'claude-code'

export type DialProps = {
  prop: string
  label: string
  value: number | null
  text: string
  min: number
  max: number
  step: number
  changed: boolean
}

type DialState = { ref: { props: DialProps }; preview: number | null; dragging: boolean; lastDown: number }

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length

function snap(value: number, { min, max, step }: DialProps): number {
  const clamped = Math.min(max, Math.max(min, value))
  return Number((Math.round(clamped / step) * step).toFixed(decimals(step)))
}

const Dial: ClientModule<DialProps, DialState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state
  if (state === undefined) {
    const ref = { props }
    const valueAt = (x: number) => {
      const p = ref.props
      const width = Math.max(1, surface.columns - 1)
      return snap(p.min + (Math.min(width, Math.max(0, x)) / width) * (p.max - p.min), p)
    }
    surface.setState({ ref, preview: null, dragging: false, lastDown: 0 })
    surface.onPointer(e => {
      const current = surface.state
      if (current === undefined) return
      const x = e.fine?.x ?? e.x
      if (e.type === 'down') {
        const now = Date.now()
        if (now - current.lastDown < 350) {
          surface.setState({ ...current, dragging: false, preview: null, lastDown: 0 })
          surface.post({ prop: ref.props.prop, edit: true })
          return
        }
        const value = valueAt(x)
        surface.setState({ ...current, dragging: true, preview: value, lastDown: now })
        surface.post({ prop: ref.props.prop, value })
      } else if (e.type === 'move' && current.dragging) {
        const value = valueAt(x)
        if (value !== current.preview) {
          surface.setState({ ...current, preview: value })
          surface.post({ prop: ref.props.prop, value })
        }
      } else if (e.type === 'up' && current.dragging) {
        surface.setState({ ...current, dragging: false })
      }
    })
    surface.onKey(e => {
      const p = ref.props
      const direction = e.key === 'right' || e.key === 'up' ? 1 : e.key === 'left' || e.key === 'down' ? -1 : 0
      if (direction === 0) return
      const base = surface.state?.preview ?? p.value ?? p.min
      const value = snap(base + direction * p.step * (e.shift ? 10 : 1), p)
      const current = surface.state
      if (current !== undefined) surface.setState({ ...current, preview: value })
      surface.post({ prop: p.prop, value })
    })
  } else {
    state.ref.props = props
  }

  // While dragging, show the dragged value; after, the page's own value (it arrives as props).
  const shown = state?.dragging ? state.preview : props.value
  const span = props.max - props.min || 1
  const fraction = shown === null ? 0 : Math.min(1, Math.max(0, (shown - props.min) / span))
  const fill = Math.round(fraction * surface.columns)
  const text = state?.dragging && shown !== null ? String(shown) : props.text

  return (
    <Box width="100%" height={1}>
      <Box position="absolute" top={0} left={0} width={fill} height={1} backgroundColor={props.changed ? 'suggestion' : 'promptBorder'} />
      <Box position="absolute" top={0} left={0} width="100%" height={1} flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text color={props.changed ? 'text' : 'subtle'}>{props.label}</Text>
        <Text bold={props.changed}>{text}</Text>
      </Box>
    </Box>
  )
}

export default Dial
