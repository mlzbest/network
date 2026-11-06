import { View, Text, Image } from '@tarojs/components';
import { useLoad } from '@tarojs/taro';

const LOADING_TIPS = [
  { iconClass: 'i-lucide-image-plus', text: '可以上传图片复刻' },
  { iconClass: 'i-lucide-sparkles', text: '不知道怎么写提示词？点一下"润色"' },
  { iconClass: 'i-lucide-mouse-pointer-click', text: '点击"编辑"——可视化选中修改' },
  { iconClass: 'i-lucide-file-up', text: '可以上传文件，AI自动解析' },
  { iconClass: 'i-lucide-bot', text: '复杂任务改不好，试试Agent模式' },
];

const ROW_H = 44;
const VISIBLE_ROWS = 3;
const TIP_COLOR = 'var(--muted-foreground)';

const PLAYFUL_CAT_IMAGE_URL =
  'https://img.alicdn.com/imgextra/i4/O1CN018N1JQc1lXjjIBL6wa_!!6000000004829-1-tps-1000-1000.gif';

/**
 * 默认首页，直接覆盖本页内容
 */
const IndexPage = () => {
  useLoad(async () => {
    console.log('页面加载完成');
  });

  return (
    <View className="min-h-screen w-full flex flex-col items-center justify-center gap-6 bg-background px-4">
      <Image
        className="w-40 h-40 object-contain"
        src={PLAYFUL_CAT_IMAGE_URL}
        mode="aspectFit"
      />

      <View
        className="relative w-full overflow-hidden"
        style={{
          height: `${VISIBLE_ROWS * ROW_H}px`,
        }}
      >
        <View
          style={{
            willChange: 'transform',
            animation: `loading-tips-scroll ${LOADING_TIPS.length * 2.2}s linear infinite`,
          }}
        >
          {[...LOADING_TIPS, ...LOADING_TIPS].map((tip, idx) => (
            <View
              key={idx}
              className="flex items-center justify-center px-2"
              style={{
                height: `${ROW_H}px`,
              }}
            >
              <Text
                className="text-center"
                style={{
                  color: TIP_COLOR,
                  fontSize: '15px',
                  lineHeight: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                }}
              >
                <View className={`${tip.iconClass} w-4 h-4`} style={{ color: TIP_COLOR }} />
                {tip.text}
              </Text>
            </View>
          ))}
        </View>

        {/* 顶部渐变遮罩 */}
        <View
          className="absolute top-0 left-0 right-0 pointer-events-none z-10"
          style={{
            height: `${ROW_H * 0.8}px`,
            background: 'linear-gradient(to bottom, var(--background) 0%, transparent 100%)'
          }}
        />

        {/* 底部渐变遮罩 */}
        <View
          className="absolute bottom-0 left-0 right-0 pointer-events-none z-10"
          style={{
            height: `${ROW_H * 0.8}px`,
            background: 'linear-gradient(to top, var(--background) 0%, transparent 100%)'
          }}
        />
      </View>
    </View>
  );
};

export default IndexPage;
