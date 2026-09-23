const CI = require('miniprogram-ci');
const https = require('https');

const APPID = 'wx24a39e0a660ee585';
const SECRET = 'd063ea956152c2bbaca2f78eea344e31';

function getToken() {
  return new Promise((resolve, reject) => {
    const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + APPID + '&secret=' + SECRET;
    console.log('Token URL:', url);
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Token response:', data);
        const j = JSON.parse(data);
        if (j.access_token) resolve(j.access_token);
        else reject(new Error(data));
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    const token = await getToken();
    console.log('Token OK:', token.slice(0, 20) + '...');

    const project = new CI.Project({
      appid: APPID,
      type: 'miniProgram',
      projectPath: '/home/maolizheng/.openclaw/workspace-main/projects/network-app/dist',
      privateKeyPath: '/home/maolizheng/.openclaw/workspace-main/projects/network-app/key/private.wx24a39e0a660ee585.key',
      ignores: ['node_modules/**']
    });

    console.log('Project loaded, uploading...');
    const result = await CI.upload({
      project,
      accessToken: token,
      version: '1.0.119',
      userVersion: '1.0.119',
      userDesc: 'Update - fix chats blank',
      onProgressUpdate: () => {}
    });
    console.log('Upload result:', JSON.stringify(result));
  } catch(e) {
    console.error('Error:', e.message);
  }
}

main();
