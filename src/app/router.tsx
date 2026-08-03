import { createBrowserRouter, redirect } from 'react-router'
import Admin from './pages/Admin'
import Health from './pages/Health'
import Login from './pages/Login'
import News from './pages/News'
import Portfolio from './pages/Portfolio'
import Terminal from './pages/Terminal'

// Eager imports on purpose: during the live event these pages must be fully
// downloaded and ready the instant a team navigates, with ZERO chance of a
// stuck "Loading…" from a lazy-chunk fetch failing on a network hiccup.
// Load-time is deliberately traded for reliability.
export const router = createBrowserRouter([
  {
    path: '/',
    loader: () => redirect('/login'),
  },
  {
    path: '/health',
    element: <Health />,
  },
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/terminal',
    element: <Terminal />,
  },
  {
    path: '/portfolio',
    element: <Portfolio />,
  },
  {
    path: '/news',
    element: <News />,
  },
  {
    path: '/admin',
    element: <Admin />,
  },
])
