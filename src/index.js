import queryString from 'query-string';

import * as photon from '@silvia-odwyer/photon';
import PHOTON_WASM from '../node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm';

import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm';

// 图片处理
const photonInstance = await WebAssembly.instantiate(PHOTON_WASM, {
	'./photon_rs_bg.js': photon,
});
photon.setWasm(photonInstance.exports); // need patch

await initWebpWasm(WEBP_ENC_WASM);

const OUTPUT_FORMATS = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

const multipleImageMode = ['watermark', 'blend'];

const inWhiteList = (env, url) => {
	const imageUrl = new URL(url);
	const whiteList = env.WHITE_LIST ? env.WHITE_LIST.split(',') : [];
	return !(whiteList.length && !whiteList.find((hostname) => imageUrl.hostname.endsWith(hostname)));
};

/**
 * resize:
 	width - New width.
	height - New height.
	sampling_filter - Nearest = 1, Triangle = 2, CatmullRom = 3, Gaussian = 4, Lanczos3 = 5
 * crop:
 	x1,
    y1,
    x2,
    y2
 */

const processImage = async (env, request, inputImage, pipeAction) => {
	const [action, options = ''] = pipeAction.split('!');
	// action can only be resize,crop. or return inputImage
	if (!['resize', 'crop'].includes(action)) {
		return inputImage;
	}
	const params = options.split(',');
	if (multipleImageMode.includes(action)) {
		const image2 = params.shift(); // 是否需要 decodeURIComponent ?
		if (image2 && inWhiteList(env, image2)) {
			const image2Res = await fetch(image2, { headers: request.headers });
			if (image2Res.ok) {
				const inputImage2 = photon.PhotonImage.new_from_byteslice(new Uint8Array(await image2Res.arrayBuffer()));
				// 多图处理是处理原图
				photon[action](inputImage, inputImage2, ...params);
				return inputImage; // 多图模式返回第一张图
			}
		}
	} else {
		return photon[action](inputImage, ...params);
	}
};

export default {
	async fetch(request, env, context) {
		// 读取缓存
		const cacheUrl = new URL(request.url);
		const cacheKey = new Request(cacheUrl.toString());
		const cache = caches.default;
		const hasCache = await cache.match(cacheKey);
		if (hasCache) {
			return hasCache;
		}
		const urlObj = new URL(request.url);
		let { pathname } = urlObj;
		// 去掉路径前缀
		pathname = pathname.replace('/', '');
		// 入参提取与校验
		const query = queryString.parse(urlObj.search);
		let { w, h, format = 'webp', quality = 75 } = query;
		const object = await env.MY_BUCKET.get(pathname);

		if (object === null) {
			return new Response('Object Not Found', { status: 404 });
		}
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);

		if (!w && !h) {
			//返回原图
			return new Response(object.body, {
				headers,
			});
		}
		if (!w) {
			w = 0;
		}
		if (!h) {
			h = 0;
		}
		//w,h参数校验
		if (isNaN(w) || isNaN(h) || w < 0 || h < 0) {
			return new Response('Invalid w or h', { status: 400 });
		}
		const imageBytes = new Uint8Array(await object.arrayBuffer());
		try {
			const inputImage = photon.PhotonImage.new_from_byteslice(imageBytes);
			const imageData = inputImage.get_image_data();
			let action = '';

			const originalWidth = imageData.width;
			const originalHeight = imageData.height;
			if (w > originalWidth || h > originalHeight) {
				return new Response(object.body, {
					headers,
				});
			}

			//如果w和h都不为0，且比例跟imageData的比例不一致，则需要先缩放再裁剪
			if (w > 0 && h > 0) {
				const targetRatio = w / h;
				const originalRatio = originalWidth / originalHeight;
				if (targetRatio !== originalRatio) {
					// 如果宽高比不一致，确定缩放维度
					let targetWidth = w;
					let targetHeight = h;
					if (targetRatio > originalRatio) {
						// 宽度较大，按照宽度进行等比缩放
						targetHeight = Math.floor(originalHeight * (w / originalWidth));
					} else {
						// 高度较大，按照高度进行等比缩放
						targetWidth = Math.floor(originalWidth * (h / originalHeight));
					}
					// 应用等比缩放后裁剪以达到目标尺寸
					action = `resize!${targetWidth},${targetHeight},1|crop!0,0,${w},${h}`;
				} else {
					action = `resize!${w},${h},1`;
				}
			} else {
				if (w == 0) {
					w = Math.floor((h * originalWidth) / originalHeight);
				}
				if (h == 0) {
					h = Math.floor((w * originalHeight) / originalWidth);
				}
				action = `resize!${w},${h},1`;
			}
			/** pipe
			 * `resize!800,400,1|watermark!https%3A%2F%2Fmt.ci%2Flogo.png,10,10,10,10`
			 */
			const pipe = action.split('|');
			const outputImage = await pipe.filter(Boolean).reduce(async (result, pipeAction) => {
				result = await result;
				return (await processImage(env, request, result, pipeAction)) || result;
			}, inputImage);
			// 图片编码
			let outputImageData;
			if (format === 'jpeg' || format === 'jpg') {
				outputImageData = outputImage.get_bytes_jpeg(quality);
			} else if (format === 'png') {
				outputImageData = outputImage.get_bytes();
			} else {
				outputImageData = await encodeWebp(outputImage.get_image_data(), { quality });
			}
			// 返回体构造
			const imageResponse = new Response(outputImageData, {
				headers: {
					'content-type': OUTPUT_FORMATS[format],
					'cache-control': 'public,max-age=15552000',
				},
			});

			// 释放资源
			inputImage.ptr && inputImage.free();
			outputImage.ptr && outputImage.free();
			// 写入缓存
			context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
			return imageResponse;
		} catch (error) {
			const errorResponse = new Response(imageBytes || null, {
				headers: headers,
				status: 'RuntimeError' === error.name ? 415 : 500,
			});
			console.log('error:', error);
			return errorResponse;
		}
	},
};
