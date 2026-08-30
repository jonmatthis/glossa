import { useEffect } from 'react'

export interface PopupState {
  text: string
  x: number
  y: number
}

export function GlossPopup({ popup, onClose }: { popup: PopupState; onClose: () => void }) {
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest('[data-gloss-popup]') || target.closest('[data-gloss-trigger]')) return
      onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  return (
    <div data-gloss-popup="1" className="popup" style={{ left: popup.x, top: popup.y }}>
      <div className="popup-card">
        <span>{popup.text}</span>
        <button type="button" className="popup-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
    </div>
  )
}
