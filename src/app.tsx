import { PropsWithChildren } from 'react';
import '@/app.css';
import { Preset } from './presets';

const DEV = (...args: any[]) => console.log(...args);

const App = ({ children }: PropsWithChildren) => {
  return <Preset>{children}</Preset>;
};

export default App;
