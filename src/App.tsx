import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/contexts/AuthContext'
import { SettingsProvider } from '@/contexts/SettingsContext'
import { ToastProvider } from '@/contexts/ToastContext'
import { VaultProvider } from '@/contexts/VaultContext'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Shell } from '@/components/Shell'
import { queryClient } from '@/lib/queryClient'
import { Home } from '@/pages/Home'
import { ListDetailLayout } from '@/pages/ListDetailLayout'
import { Login } from '@/pages/Login'
import { NotePage } from '@/pages/NotePage'

// Secondary screens load on demand to keep first paint and capture fast.
const Tasks = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.Tasks })))
const Board = lazy(() => import('@/pages/Board').then((m) => ({ default: m.Board })))
const Search = lazy(() => import('@/pages/Search').then((m) => ({ default: m.Search })))
const TagIndex = lazy(() => import('@/pages/Index').then((m) => ({ default: m.TagIndex })))
const TagPage = lazy(() => import('@/pages/TagPage').then((m) => ({ default: m.TagPage })))
const Inbox = lazy(() => import('@/pages/Inbox').then((m) => ({ default: m.Inbox })))
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })))
const Passwords = lazy(() => import('@/pages/Passwords').then((m) => ({ default: m.Passwords })))
const Habits = lazy(() => import('@/pages/Habits').then((m) => ({ default: m.Habits })))
const Share = lazy(() => import('@/pages/Share').then((m) => ({ default: m.Share })))

const Fallback = <div className="p-8 text-sm text-faint">Loading…</div>

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SettingsProvider>
          <ToastProvider>
            <VaultProvider>
            <BrowserRouter>
              <Suspense fallback={Fallback}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route element={<ProtectedRoute><Shell /></ProtectedRoute>}>
                    <Route index element={<Home />} />
                    <Route element={<ListDetailLayout />}>
                      <Route path="notes" element={null} />
                      <Route path="starred" element={null} />
                      <Route path="archive" element={null} />
                      <Route path="trash" element={null} />
                      <Route path="n/:publicId" element={<NotePage />} />
                    </Route>
                    <Route path="inbox" element={<Inbox />} />
                    <Route path="tasks" element={<Tasks />} />
                    <Route path="tasks/board" element={<Board />} />
                    <Route path="habits" element={<Habits />} />
                    <Route path="search" element={<Search />} />
                    <Route path="tags" element={<TagIndex />} />
                    <Route path="tags/*" element={<TagPage />} />
                    <Route path="passwords" element={<Passwords />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="share" element={<Share />} />
                    <Route path="*" element={<div className="p-8"><h1 className="text-lg font-semibold">Not found</h1></div>} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
            </VaultProvider>
          </ToastProvider>
        </SettingsProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
