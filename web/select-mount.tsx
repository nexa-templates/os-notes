import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Select, type SelectOption } from './select'

export function mountSelect(element: HTMLElement, options: SelectOption[], label: string, initial: string, changed?: (value: string) => void) {
  const [value, setValue] = createSignal(initial)
  const dispose = render(() => <Select options={options} value={value()} aria-label={label} onChange={next => { setValue(next); changed?.(next) }} />, element)
  return { get value() { return value() }, set value(next: string) { setValue(next) }, dispose }
}
