import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TOKEN, connect } from './lib/store';
import './styles/app.css';

if (TOKEN) connect();
createRoot(document.getElementById('root')!).render(<App />);
