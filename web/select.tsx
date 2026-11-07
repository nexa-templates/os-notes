import * as Primitive from '@kobalte/core/select'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'

export type SelectOption = { value: string | number; label: string; disabled?: boolean }
export type SelectProps = {
  options: SelectOption[]
  value?: string | number
  defaultValue?: string | number
  onChange?: (value: string) => void
  label?: string
  'aria-label'?: string
  name?: string
  required?: boolean
  disabled?: boolean
  hidden?: boolean
  placeholder?: string
  searchable?: boolean
  class?: string
  variant?: 'tag'
  'data-resource'?: boolean
  'data-range'?: boolean
}

/** Nexa's select: custom popup everywhere, including touch devices and dialogs. */
export function Select(props: SelectProps) {
  let trigger!: HTMLButtonElement, listbox!: HTMLUListElement
  let restoreFocus = true
  const [value, setValue] = createSignal(props.defaultValue), [open, setOpen] = createSignal(false), [invalid, setInvalid] = createSignal(false)
  const [mount, setMount] = createSignal<HTMLElement>()
  const [search, setSearch] = createSignal('')
  const options = createMemo(() => props.searchable && search().trim() ? props.options.filter(option => (option.label + ' ' + option.value).toLowerCase().includes(search().trim().toLowerCase())) : props.options)
  const selected = createMemo(() => {
    const key = props.value ?? value() ?? props.options.find(option => !option.disabled)?.value
    return props.options.find(option => String(option.value) === String(key))
  })
  const change = (option: SelectOption | null) => {
    // Refreshed option objects can notify Kobalte without a user value change.
    if (!option || String(option.value) === String(selected()?.value)) return
    setValue(option.value); setInvalid(false); props.onChange?.(String(option.value))
    if (props.searchable) setOpen(false)
  }
  createEffect(() => { if (selected()) setInvalid(false) })
  onMount(() => {
    // Portals must stay inside the native dialog's top layer and focus boundary.
    setMount(trigger.closest('dialog') || document.body)
    const form = trigger.closest('form'), initial = selected()?.value
    const reset = () => { setValue(initial); setInvalid(false); setOpen(false); if (initial !== undefined) props.onChange?.(String(initial)) }
    form?.addEventListener('reset', reset)
    onCleanup(() => form?.removeEventListener('reset', reset))
  })
  return <Primitive.Root<SelectOption> class={'ui-select ' + (props.class || '')} hidden={props.hidden} data-resource={props['data-resource']} data-range={props['data-range']}
    options={options()} optionValue={option => String(option.value)} optionTextValue="label" optionDisabled="disabled"
    value={selected() ?? null} onChange={change} open={open()} onOpenChange={value => { if (value) restoreFocus = true; else setSearch(''); setOpen(value) }} disabled={props.disabled}
    required={props.required} validationState={invalid() ? 'invalid' : undefined} disallowEmptySelection closeOnSelection={!props.searchable}
    placeholder={props.placeholder || 'Choose an option'} modal={false} placement="bottom-start" gutter={4} sameWidth fitViewport
    itemComponent={item => <Primitive.Item item={item.item} class="ui-select-option" onClick={() => { if (props.searchable && !item.item.rawValue.disabled) setOpen(false) }}>
      <Primitive.ItemLabel class="ui-select-option-label">{item.item.rawValue.label}</Primitive.ItemLabel>
      <Primitive.ItemIndicator><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg></Primitive.ItemIndicator>
    </Primitive.Item>}>
    <Primitive.Label class={props.label ? 'ui-select-label' : 'sr-only'}><span aria-hidden={!!props['aria-label']}>{props.label}</span><Show when={props['aria-label']}><span class={props.label ? 'sr-only' : undefined}>{props['aria-label']}</span></Show></Primitive.Label>
    <input type="hidden" name={props.name} value={selected()?.value ?? ''} disabled={props.disabled} />
    <Show when={props.required}><input class="ui-select-validation" aria-hidden="true" tabindex={-1} required value={selected()?.value ?? ''} disabled={props.disabled}
      onFocus={() => trigger.focus()} onInvalid={event => { event.preventDefault(); setInvalid(true); trigger.focus() }} /></Show>
    <Primitive.Trigger ref={trigger} class="ui-select-trigger" classList={{ 'ui-select-tag': props.variant === 'tag' }} role="combobox" aria-required={props.required} aria-invalid={invalid() || undefined} data-value={selected()?.value ?? ''}>
      <span class="ui-select-value">{selected()?.label || props.placeholder || 'Choose an option'}</span>
      <Show when={props.variant !== 'tag'}><Primitive.Icon><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg></Primitive.Icon></Show>
    </Primitive.Trigger>
    <Primitive.Portal mount={mount()}><Primitive.Content class="ui-select-content" classList={{ 'ui-select-searchable': props.searchable, 'ui-select-tag-content': props.variant === 'tag' }}
      onFocusOutside={() => { restoreFocus = false }} onCloseAutoFocus={event => { if (!restoreFocus) event.preventDefault() }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        if (event.key === 'Tab') { restoreFocus = false; setOpen(false); trigger.focus() }
      }}>
      <Show when={props.searchable}><input class="ui-select-search" type="search" aria-label={'Search ' + (props.label?.toLowerCase() || 'options')} placeholder="Search…" autocomplete="off" value={search()} ref={element => queueMicrotask(() => element.focus())} onInput={event => setSearch(event.currentTarget.value)} onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') return
        event.stopPropagation()
        if (event.key === 'Enter') event.preventDefault()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const items = listbox.querySelectorAll<HTMLElement>('[role="option"]:not([data-disabled])')
          items[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus()
        }
      }} /></Show>
      <Primitive.Listbox ref={listbox} class="ui-select-listbox" {...(props.searchable ? { autoFocus: false } : {})} />
      <Show when={props.searchable && !options().length}><p class="ui-select-empty" role="status">No matches</p></Show>
    </Primitive.Content></Primitive.Portal>
  </Primitive.Root>
}
