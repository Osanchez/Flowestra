// Agent Board: the navbar (0.13.0). Pure: no `$`, no state reads.
// Two plain Buttons with hotkeys. A Button's children are strings and Text
// only: a Box inside a Button makes the whole pane fail to draw.

import type { RenderElement } from 'claude-code'

import type { El, ViewModel } from './view'

export const NAV_ROWS = 1

type Tab = 'board' | 'tokens'

export function drawNav(el: El, vm: ViewModel): RenderElement {
  const { Box, Text, Button } = el
  const tab: Tab = ((vm.ui as { tab?: Tab }).tab ?? 'board') === 'tokens' ? 'tokens' : 'board'
  return (
    <Box key="nav" width={vm.width}>
      <Button key="tab-board" plain hotkey="b" dimColor={tab !== 'board'} onPress={() => vm.onTab?.('board')}>
        {tab === 'board' ? (
          <Text bold underline>
            Board
          </Text>
        ) : (
          'Board'
        )}
      </Button>
      <Text>{'  '}</Text>
      <Button key="tab-tokens" plain hotkey="t" dimColor={tab !== 'tokens'} onPress={() => vm.onTab?.('tokens')}>
        {tab === 'tokens' ? (
          <Text bold underline>
            Tokens
          </Text>
        ) : (
          'Tokens'
        )}
      </Button>
    </Box>
  )
}
