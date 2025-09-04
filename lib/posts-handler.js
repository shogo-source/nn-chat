'use strict';
const pug = require('pug');
const Cookies = require('cookies');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [ 'query' ] });
const util = require('./handler-util');
const {currentThemeKey} = require('../config'); //cookieは必ずkeyと値がセットになる

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const relativeTime = require('dayjs/plugin/relativeTime');
require('dayjs/locale/ja');
dayjs.locale('ja');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.tz.setDefault('Asia/Tokyo');
const crypto = require('node:crypto');

const oneTimeTokenMap = new Map();   // キーをユーザ名、値をトークンとする連想配列

async function handle(req, res) {
  const cookies = new Cookies(req, res);
  const currentTheme = cookies.get(currentThemeKey) || 'light';
  const options = { maxAge: 30 * 86400 * 1000 };
  cookies.set(currentThemeKey, currentTheme, options);
  switch(req.method) {
    case 'GET':
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src https://* http://localhost:8000/; style-src https://* http://localhost:8000/; font-src https://*;"
      });
      const posts = await prisma.post.findMany(
        {
          orderBy: {
            id: 'asc'
          }
        }
      );
      posts.forEach((post) => {
        post.relativeCreatedAt = dayjs(post.createdAt).tz().fromNow();
        post.formattedCreatedAt = dayjs(post.createdAt).tz().format('YYYY年MM月DD日 HH時mm分ss秒');
      });
      const oneTimeToken = crypto.randomBytes(8).toString('hex');
      oneTimeTokenMap.set(req.user, oneTimeToken);
      res.end(pug.renderFile('./views/posts.pug',{
        currentTheme,
        posts,
        user: req.user,
        oneTimeToken
      }));
      console.info(
        `閲覧されました: user: ${req.user}, ` +
        `remoteAddress: ${req.socket.remoteAddress}, ` +
        `userAgent: ${req.headers['user-agent']} `
      );
      break;
    case 'POST':
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      }).on('end', async() => {
        //キー名と値になっているので getでcontentを取る
        const params = new URLSearchParams(body);
        const content = params.get('content');
        const requestedOneTimeToken = params.get('oneTimeToken');
        if(!content){
          handleRedirectPosts(req, res);
          return;
        }
        if(!requestedOneTimeToken){
          util.handleBadRequest(req, res);
          return;
        }
        if(oneTimeTokenMap.get(req.user) !== requestedOneTimeToken){
          util.handleBadRequest(req, res);
          return;
        }
        console.info(`送信されました: ${content}`);
        await prisma.post.create({
          data: {
            content,
            postedBy: req.user
          }
        });
        oneTimeTokenMap.delete(req.user);
        //リダイレクトさせる　これがないと投稿した文字が残る
        handleRedirectPosts(req, res);
      })
      break;
    default:
      //普通ブラウザからget post 以外のリクエストは基本来ない　コマンドからくることしかない
      util.handleBadRequest(req, res);
      break;
  }
}

function handleRedirectPosts(req, res) {
  res.writeHead(303, {
    'Location': '/posts'
  });
  res.end();
}

function handleDelete(req, res){
  switch (req.method){
    case 'POST':
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      }).on('end', async() => {
        const params = new URLSearchParams(body);
        //URLSearchParamsで取得した中のidを取得　通信の際全て文字列なのでintに変換
        const id = parseInt(params.get('id'));
        const requestedOneTimeToken = params.get('oneTimeToken');
        if(!id){
          handleRedirectPosts(req, res);
          return;
        }
        if(!requestedOneTimeToken){
          util.handleBadRequest(req, res);
          return;
        }
        if(oneTimeTokenMap.get(req.user) !== requestedOneTimeToken){
          util.handleBadRequest(req, res);
          return;
        }
        //findUniqueで高速に探す
        const post = await prisma.post.findUnique({
          where: {id}
        });
        //何のためサーバ側でも確認 コード等でリクエストできてしまうから
        if(req.user === post.postedBy || req.user === 'admin'){
          await prisma.post.delete({
            where: {id}
          });
          console.info(
          `削除されました: user: ${req.user}, ` +
          `remoteAddress: ${req.socket.remoteAddress}, ` +
          `userAgent: ${req.headers['user-agent']} `
          );
          handleRedirectPosts(req, res);
        }
      });
      break;
    default:
      //削除できなかったとき
      util.handleBadRequest(req, res);
      break;
  }
}

module.exports = {
  handle,
  handleDelete
};