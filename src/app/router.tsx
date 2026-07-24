import { createBrowserRouter, redirect } from 'react-router'
import Health from './pages/Health'
import Login from './pages/Login'

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
])
