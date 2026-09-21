import { useLaunch } from '@tarojs/taro';
import { PropsWithChildren } from 'react';
import { injectH5Styles } from './h5-styles';
import { devDebug } from './dev-debug';
import { H5Container } from './h5-container';
import { IS_H5_ENV } from './env';

export const Preset = ({ children }: PropsWithChildren) => {
  useLaunch(() => {
    devDebug();
    injectH5Styles();
  });

  if (IS_H5_ENV) {
    return <H5Container>{children}</H5Container>;
  }

  return <>{children}</>;
};
