import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { App } from './App.js'

it('renders the placeholder', () => {
  expect(renderToStaticMarkup(createElement(App))).toBe('<h1>Bancada</h1>')
})
