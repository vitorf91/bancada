import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Wordmark } from './index.js'

it('renders the wordmark with React 19', () => {
  expect(renderToStaticMarkup(createElement(Wordmark))).toBe('<span>Bancada</span>')
})
