const states = {
  eligible: {
    icon: '✓',
    label: 'ELIGIBILITY RESULT',
    title: 'Eligible to register',
    description: 'This SGT can create one immutable receipt for this campaign.',
    stamp: 'OPEN',
  },
  used: {
    icon: '×',
    label: 'EXISTING RECEIPT',
    title: 'Already registered',
    description: 'This SGT mint already has a receipt in the campaign, even if a different wallet tries again.',
    stamp: 'USED',
  },
  missing: {
    icon: '–',
    label: 'TOKEN CHECK',
    title: 'No verified SGT',
    description: 'This wallet cannot register until it holds a valid Seeker Genesis Token.',
    stamp: 'NO SGT',
  },
}

const result = document.querySelector('#sample-result')
const icon = document.querySelector('#result-icon')
const label = document.querySelector('#result-label')
const title = document.querySelector('#result-title')
const description = document.querySelector('#result-description')
const stamp = document.querySelector('#result-stamp')
const buttons = document.querySelectorAll('.sample-button')

for (const button of buttons) {
  button.addEventListener('click', () => {
    const stateName = button.dataset.state
    const state = states[stateName]
    if (!state) return
    result.dataset.state = stateName
    icon.textContent = state.icon
    label.textContent = state.label
    title.textContent = state.title
    description.textContent = state.description
    stamp.textContent = state.stamp
    result.classList.remove('stamp-in')
    void result.offsetWidth
    result.classList.add('stamp-in')
    for (const choice of buttons) choice.setAttribute('aria-pressed', String(choice === button))
  })
}
