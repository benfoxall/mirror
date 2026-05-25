import { BrowserRouter, Routes, Route } from 'react-router'
import Root from './pages/Root'
import UserPage from './pages/UserPage'
import './app.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="/:user" element={<UserPage />} />
      </Routes>
    </BrowserRouter>
  )
}
