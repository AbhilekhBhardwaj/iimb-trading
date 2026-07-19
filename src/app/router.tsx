import { createBrowserRouter } from 'react-router'
import Home from './pages/Home'
import Health from './pages/Health'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Home />,
  },
  {
    path: '/health',
    element: <Health />,
  },
])
