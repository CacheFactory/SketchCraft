const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  devtool: 'source-map',
  entry: './src/web/index.tsx',
  target: 'web',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    conditionNames: ['import', 'module', 'browser', 'default'],
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
  externals: {
    // These native modules are stubs in the web bridge — provide empty module shims
    'manifold-3d': 'var {}',
    'opencascade.js': 'var {}',
  },
  output: {
    path: path.resolve(__dirname, 'dist/web'),
    filename: '[name].[contenthash].js',
    publicPath: '/',
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/web/index.html',
    }),
    new webpack.DefinePlugin({
      'process.env.PLATFORM': JSON.stringify('web'),
    }),
  ],
  devServer: {
    port: 3001,
    hot: true,
    historyApiFallback: true,
  },
  performance: {
    hints: false,
  },
};
