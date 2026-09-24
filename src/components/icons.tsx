import type { SVGProps } from 'react'

// Tiny inline icon set (24px grid, 1.75 stroke): no icon-library weight in the bundle.
type P = SVGProps<SVGSVGElement> & { size?: number }
const base = (size = 20): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
})
const mk = (d: React.ReactNode) => ({ size, ...rest }: P) => <svg {...base(size)} {...rest}>{d}</svg>

export const IconPlus = mk(<path d="M12 5v14M5 12h14" />)
export const IconSearch = mk(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></>)
export const IconToday = mk(<><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M4 10h16" /></>)
export const IconNotes = mk(<><path d="M6 4h9l3 3v13H6z" /><path d="M9 11h6M9 15h6" /></>)
export const IconTasks = mk(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></>)
export const IconTag = mk(<path d="M9 4 7.5 20M16.5 4 15 20M4 9h16M3.5 15h16" />)
export const IconStar = mk(<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" />)
export const IconStarFill = ({ size, ...rest }: P) => <svg {...base(size)} fill="currentColor" {...rest}><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" /></svg>
export const IconArchive = mk(<><rect x="3.5" y="4.5" width="17" height="4.5" rx="1" /><path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>)
export const IconTrash = mk(<><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" /></>)
export const IconSettings = mk(<><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>)
export const IconInbox = mk(<><path d="M4 13.5 6.5 5h11L20 13.5V19H4z" /><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20" /></>)
export const IconMore = mk(<><circle cx="5.5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" /></>)
export const IconBack = mk(<path d="M15 5 8 12l7 7" />)
export const IconLink = mk(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>)
export const IconX = mk(<path d="M6 6l12 12M18 6 6 18" />)
export const IconCheck = mk(<path d="m5 12.5 4.5 4.5L19 7.5" />)
export const IconCloudOff = mk(<><path d="M9 6.5A6 6 0 0 1 18 11a4 4 0 0 1 3 3.8M7 18a4.5 4.5 0 0 1-.5-9" /><path d="m3 3 18 18" /></>)
export const IconCommand = mk(<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9m0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15m0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15m0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9" />)
export const IconDownload = mk(<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14" />)
export const IconCalendar = IconToday
export const IconHabit = mk(<><path d="M20 12a8 8 0 1 1-2.35-5.65M20 4v4h-4" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></>)
export const IconChevron = mk(<path d="m9 5 7 7-7 7" />)
export const IconSun = mk(<><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>)

/** Brand mark: an "M" drawn as a single continuous stroke. */
export const IconMark = mk(<path d="M5 18V7l7 8 7-8v11" strokeWidth={2.4} />)

export const IconKey = mk(<><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 6.5l2.5 2.5M14 8.5l2 2" /></>)
export const IconCopy = mk(<><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2" /></>)
export const IconEye = mk(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" /></>)
export const IconEyeOff = mk(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" /><path d="m4 4 16 16" /></>)
export const IconLock = mk(<><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>)
export const IconExternal = mk(<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />)
export const IconSteps = mk(<><circle cx="5.5" cy="5.5" r="2" /><circle cx="5.5" cy="12" r="2" /><circle cx="5.5" cy="18.5" r="2" /><path d="M5.5 7.5v2.5M5.5 14v2.5M10.5 5.5H20M10.5 12H20M10.5 18.5H20" /></>)
export const IconClock = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>)
export const IconEdit = mk(<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l3 3" />)
export const IconWand = mk(<path d="M5 19 16 8M14 6l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM18.5 13l.6-1.3.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6z" />)

// task-menu actions
export const IconSubtask = mk(<path d="M6 4v9a3 3 0 0 0 3 3h9m-3.5-3.5L18 16l-3.5 3.5" />)
export const IconArrowUp = mk(<path d="M12 19V5m-6 6 6-6 6 6" />)
export const IconArrowDown = mk(<path d="M12 5v14m-6-6 6 6 6-6" />)
export const IconHourglass = mk(<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 8 5 8 8.5s-8 4.5-8 8.5M16 3.5c0 4-8 5-8 8.5s8 4.5 8 8.5" />)
export const IconMoveUnder = mk(<><rect x="4" y="3.5" width="16" height="6" rx="2" /><path d="M8 9.5v6a2 2 0 0 0 2 2h9m-3-3 3 3-3 3" /></>)
export const IconPullIn = mk(<><rect x="4" y="3.5" width="16" height="6" rx="2" /><path d="M8 9.5v6a2 2 0 0 0 2 2h1M20 14.5v6M17 17.5h6" /></>)
export const IconUnnest = mk(<path d="M18 20v-7a3 3 0 0 0-3-3H6m3.5-3.5L6 10l3.5 3.5" />)
export const IconBoard = mk(<><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><rect x="6.5" y="7" width="5" height="4" rx="1" /><rect x="12.5" y="13" width="5" height="4" rx="1" /><path d="M11.5 9h2.5v4" /></>)
export const IconSnooze = mk(<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10zM14 4h4l-4 4.5h4" />)
export const IconTree = mk(<><rect x="9" y="3" width="6" height="4.5" rx="1.2" /><rect x="3" y="16.5" width="6" height="4.5" rx="1.2" /><rect x="15" y="16.5" width="6" height="4.5" rx="1.2" /><path d="M12 7.5V12M6 16.5V12h12v4.5" /></>)
export const IconFlame = mk(<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.1 2-5.2 3.6-7 .4 1.7 1.3 2.8 2.4 3.4C11.8 7.6 13 5 15 3c.3 2.6 1.5 4.4 2.6 6 .9 1.4 1.4 2.9 1.4 4.8 0 4.1-2.8 7.2-7 7.2z" />)
export const IconFlag = mk(<path d="M5.5 21V4m0 0h11l-2 4 2 4h-11" />)
