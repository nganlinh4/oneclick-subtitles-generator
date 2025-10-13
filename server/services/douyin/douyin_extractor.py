#!/usr/bin/env python
# Custom Douyin extractor for yt-dlp

import re
import json
import sys
import os
import urllib.request
import urllib.parse
import time
import random
import subprocess
import shutil

from random import choice
from random import randint
import random
from re import compile
import time
from urllib.parse import urlencode
from urllib.parse import quote
from gmssl import sm3, func


class ABogus:
    __filter = compile(r'%([0-9A-F]{2})')
    __arguments = [0, 1, 14]
    __ua_key = "\u0000\u0001\u000e"
    __end_string = "cus"
    __version = [1, 0, 1, 5]
    __browser = "1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|MacIntel"
    __reg = [
        1937774191,
        1226093241,
        388252375,
        3666478592,
        2842636476,
        372324522,
        3817729613,
        2969243214,
    ]
    __str = {
        "s0": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
        "s1": "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
        "s2": "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
        "s3": "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
        "s4": "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
    }

    def __init__(self,
                 # user_agent: str = USERAGENT,
                 platform: str = None, ):
        self.chunk = []
        self.size = 0
        self.reg = self.__reg[:]
        # self.ua_code = self.generate_ua_code(user_agent)
        # Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36
        self.ua_code = [
            76,
            98,
            15,
            131,
            97,
            245,
            224,
            133,
            122,
            199,
            241,
            166,
            79,
            34,
            90,
            191,
            128,
            126,
            122,
            98,
            66,
            11,
            14,
            40,
            49,
            110,
            110,
            173,
            67,
            96,
            138,
            252]
        self.browser = self.generate_browser_info(
            platform) if platform else self.__browser
        self.browser_len = len(self.browser)
        self.browser_code = self.char_code_at(self.browser)

    @classmethod
    def list_1(cls, random_num=None, a=170, b=85, c=45, ) -> list:
        return cls.random_list(
            random_num,
            a,
            b,
            1,
            2,
            5,
            c & a,
        )

    @classmethod
    def list_2(cls, random_num=None, a=170, b=85, ) -> list:
        return cls.random_list(
            random_num,
            a,
            b,
            1,
            0,
            0,
            0,
        )

    @classmethod
    def list_3(cls, random_num=None, a=170, b=85, ) -> list:
        return cls.random_list(
            random_num,
            a,
            b,
            1,
            0,
            5,
            0,
        )

    @staticmethod
    def random_list(
            a: float = None,
            b=170,
            c=85,
            d=0,
            e=0,
            f=0,
            g=0,
    ) -> list:
        r = a or (random.random() * 10000)
        v = [
            r,
            int(r) & 255,
            int(r) >> 8,
        ]
        s = v[1] & b | d
        v.append(s)
        s = v[1] & c | e
        v.append(s)
        s = v[2] & b | f
        v.append(s)
        s = v[2] & c | g
        v.append(s)
        return v[-4:]

    @staticmethod
    def from_char_code(*args):
        return "".join(chr(code) for code in args)

    @classmethod
    def generate_string_1(
            cls,
            random_num_1=None,
            random_num_2=None,
            random_num_3=None,
    ):
        return cls.from_char_code(*cls.list_1(random_num_1)) + cls.from_char_code(
            *cls.list_2(random_num_2)) + cls.from_char_code(*cls.list_3(random_num_3))

    def generate_string_2(
            self,
            url_params: str,
            method="GET",
            start_time=0,
            end_time=0,
    ) -> str:
        a = self.generate_string_2_list(
            url_params,
            method,
            start_time,
            end_time,
        )
        e = self.end_check_num(a)
        a.extend(self.browser_code)
        a.append(e)
        return self.rc4_encrypt(self.from_char_code(*a), "y")

    def generate_string_2_list(
            self,
            url_params: str,
            method="GET",
            start_time=0,
            end_time=0,
    ) -> list:
        start_time = start_time or int(time.time() * 1000)
        end_time = end_time or (start_time + randint(4, 8))
        params_array = self.generate_params_code(url_params)
        method_array = self.generate_method_code(method)
        return self.list_4(
            (end_time >> 24) & 255,
            params_array[21],
            self.ua_code[23],
            (end_time >> 16) & 255,
            params_array[22],
            self.ua_code[24],
            (end_time >> 8) & 255,
            (end_time >> 0) & 255,
            (start_time >> 24) & 255,
            (start_time >> 16) & 255,
            (start_time >> 8) & 255,
            (start_time >> 0) & 255,
            method_array[21],
            method_array[22],
            int(end_time / 256 / 256 / 256 / 256) >> 0,
            int(start_time / 256 / 256 / 256 / 256) >> 0,
            self.browser_len,
        )

    @staticmethod
    def reg_to_array(a):
        o = [0] * 32
        for i in range(8):
            c = a[i]
            o[4 * i + 3] = (255 & c)
            c >>= 8
            o[4 * i + 2] = (255 & c)
            c >>= 8
            o[4 * i + 1] = (255 & c)
            c >>= 8
            o[4 * i] = (255 & c)

        return o

    def compress(self, a):
        f = self.generate_f(a)
        i = self.reg[:]
        for o in range(64):
            c = self.de(i[0], 12) + i[4] + self.de(self.pe(o), o)
            c = (c & 0xFFFFFFFF)
            c = self.de(c, 7)
            s = (c ^ self.de(i[0], 12)) & 0xFFFFFFFF

            u = self.he(o, i[0], i[1], i[2])
            u = (u + i[3] + s + f[o + 68]) & 0xFFFFFFFF

            b = self.ve(o, i[4], i[5], i[6])
            b = (b + i[7] + c + f[o]) & 0xFFFFFFFF

            i[3] = i[2]
            i[2] = self.de(i[1], 9)
            i[1] = i[0]
            i[0] = u

            i[7] = i[6]
            i[6] = self.de(i[5], 19)
            i[5] = i[4]
            i[4] = (b ^ self.de(b, 9) ^ self.de(b, 17)) & 0xFFFFFFFF

        for l in range(8):
            self.reg[l] = (self.reg[l] ^ i[l]) & 0xFFFFFFFF

    @classmethod
    def generate_f(cls, e):
        r = [0] * 132

        for t in range(16):
            r[t] = (e[4 * t] << 24) | (e[4 * t + 1] <<
                                       16) | (e[4 * t + 2] << 8) | e[4 * t + 3]
            r[t] &= 0xFFFFFFFF

        for n in range(16, 68):
            a = r[n - 16] ^ r[n - 9] ^ cls.de(r[n - 3], 15)
            a = a ^ cls.de(a, 15) ^ cls.de(a, 23)
            r[n] = (a ^ cls.de(r[n - 13], 7) ^ r[n - 6]) & 0xFFFFFFFF

        for n in range(68, 132):
            r[n] = (r[n - 68] ^ r[n - 64]) & 0xFFFFFFFF

        return r

    @staticmethod
    def pad_array(arr, length=60):
        while len(arr) < length:
            arr.append(0)
        return arr

    def fill(self, length=60):
        size = 8 * self.size
        self.chunk.append(128)
        self.chunk = self.pad_array(self.chunk, length)
        for i in range(4):
            self.chunk.append((size >> 8 * (3 - i)) & 255)

    @staticmethod
    def list_4(
            a: int,
            b: int,
            c: int,
            d: int,
            e: int,
            f: int,
            g: int,
            h: int,
            i: int,
            j: int,
            k: int,
            m: int,
            n: int,
            o: int,
            p: int,
            q: int,
            r: int,
    ) -> list:
        return [
            44,
            a,
            0,
            0,
            0,
            0,
            24,
            b,
            n,
            0,
            c,
            d,
            0,
            0,
            0,
            1,
            0,
            239,
            e,
            o,
            f,
            g,
            0,
            0,
            0,
            0,
            h,
            0,
            0,
            14,
            i,
            j,
            0,
            k,
            m,
            3,
            p,
            1,
            q,
            1,
            r,
            0,
            0,
            0]

    @staticmethod
    def end_check_num(a: list):
        r = 0
        for i in a:
            r ^= i
        return r

    @classmethod
    def decode_string(cls, url_string, ):
        decoded = cls.__filter.sub(cls.replace_func, url_string)
        return decoded

    @staticmethod
    def replace_func(match):
        return chr(int(match.group(1), 16))

    @staticmethod
    def de(e, r):
        r %= 32
        return ((e << r) & 0xFFFFFFFF) | (e >> (32 - r))

    @staticmethod
    def pe(e):
        return 2043430169 if 0 <= e < 16 else 2055708042

    @staticmethod
    def he(e, r, t, n):
        if 0 <= e < 16:
            return (r ^ t ^ n) & 0xFFFFFFFF
        elif 16 <= e < 64:
            return (r & t | r & n | t & n) & 0xFFFFFFFF
        raise ValueError

    @staticmethod
    def ve(e, r, t, n):
        if 0 <= e < 16:
            return (r ^ t ^ n) & 0xFFFFFFFF
        elif 16 <= e < 64:
            return (r & t | ~r & n) & 0xFFFFFFFF
        raise ValueError

    @staticmethod
    def convert_to_char_code(a):
        d = []
        for i in a:
            d.append(ord(i))
        return d

    @staticmethod
    def split_array(arr, chunk_size=64):
        result = []
        for i in range(0, len(arr), chunk_size):
            result.append(arr[i:i + chunk_size])
        return result

    @staticmethod
    def char_code_at(s):
        return [ord(char) for char in s]

    def write(self, e, ):
        self.size = len(e)
        if isinstance(e, str):
            e = self.decode_string(e)
            e = self.char_code_at(e)
        if len(e) <= 64:
            self.chunk = e
        else:
            chunks = self.split_array(e, 64)
            for i in chunks[:-1]:
                self.compress(i)
            self.chunk = chunks[-1]

    def reset(self, ):
        self.chunk = []
        self.size = 0
        self.reg = self.__reg[:]

    def sum(self, e, length=60):
        self.reset()
        self.write(e)
        self.fill(length)
        self.compress(self.chunk)
        return self.reg_to_array(self.reg)

    @classmethod
    def generate_result_unit(cls, n, s):
        r = ""
        for i, j in zip(range(18, -1, -6), (16515072, 258048, 4032, 63)):
            r += cls.__str[s][(n & j) >> i]
        return r

    @classmethod
    def generate_result_end(cls, s, e="s4"):
        r = ""
        b = ord(s[120]) << 16
        r += cls.__str[e][(b & 16515072) >> 18]
        r += cls.__str[e][(b & 258048) >> 12]
        r += "=="
        return r

    @classmethod
    def generate_result(cls, s, e="s4"):
        # r = ""
        # for i in range(len(s)//4):
        #     b = ((ord(s[i]) << 16) | (ord(s[i * 3]) <<
        #          8) | ord(s[i * 3 + 2]))
        #     r += cls.generate_result_unit(b, e)
        # return r

        r = []

        for i in range(0, len(s), 3):
            if i + 2 < len(s):
                n = (
                    (ord(s[i]) << 16)
                    | (ord(s[i + 1]) << 8)
                    | ord(s[i + 2])
                )
            elif i + 1 < len(s):
                n = (ord(s[i]) << 16) | (
                    ord(s[i + 1]) << 8
                )
            else:
                n = ord(s[i]) << 16

            for j, k in zip(range(18, -1, -6),
                            (0xFC0000, 0x03F000, 0x0FC0, 0x3F)):
                if j == 6 and i + 1 >= len(s):
                    break
                if j == 0 and i + 2 >= len(s):
                    break
                r.append(cls.__str[e][(n & k) >> j])

        r.append("=" * ((4 - len(r) % 4) % 4))
        return "".join(r)

    @classmethod
    def generate_args_code(cls):
        a = []
        for j in range(24, -1, -8):
            a.append(cls.__arguments[0] >> j)
        a.append(cls.__arguments[1] / 256)
        a.append(cls.__arguments[1] % 256)
        a.append(cls.__arguments[1] >> 24)
        a.append(cls.__arguments[1] >> 16)
        for j in range(24, -1, -8):
            a.append(cls.__arguments[2] >> j)
        return [int(i) & 255 for i in a]

    def generate_method_code(self, method: str = "GET") -> list[int]:
        return self.sm3_to_array(self.sm3_to_array(method + self.__end_string))
        # return self.sum(self.sum(method + self.__end_string))

    def generate_params_code(self, params: str) -> list[int]:
        return self.sm3_to_array(self.sm3_to_array(params + self.__end_string))
        # return self.sum(self.sum(params + self.__end_string))

    @classmethod
    def sm3_to_array(cls, data: str | list) -> list[int]:
        """
        代码参考: https://github.com/Johnserf-Seed/f2/blob/main/f2/utils/abogus.py

        计算请求体的 SM3 哈希值，并将结果转换为整数数组
        Calculate the SM3 hash value of the request body and convert the result to an array of integers

        Args:
            data (Union[str, List[int]]): 输入数据 (Input data).

        Returns:
            List[int]: 哈希值的整数数组 (Array of integers representing the hash value).
        """

        if isinstance(data, str):
            b = data.encode("utf-8")
        else:
            b = bytes(data)  # 将 List[int] 转换为字节数组

        # 将字节数组转换为适合 sm3.sm3_hash 函数处理的列表格式
        h = sm3.sm3_hash(func.bytes_to_list(b))

        # 将十六进制字符串结果转换为十进制整数列表
        return [int(h[i: i + 2], 16) for i in range(0, len(h), 2)]

    @classmethod
    def generate_browser_info(cls, platform: str = "Win32") -> str:
        inner_width = randint(1280, 1920)
        inner_height = randint(720, 1080)
        outer_width = randint(inner_width, 1920)
        outer_height = randint(inner_height, 1080)
        screen_x = 0
        screen_y = choice((0, 30))
        value_list = [
            inner_width,
            inner_height,
            outer_width,
            outer_height,
            screen_x,
            screen_y,
            0,
            0,
            outer_width,
            outer_height,
            outer_width,
            outer_height,
            inner_width,
            inner_height,
            24,
            24,
            platform,
        ]
        return "|".join(str(i) for i in value_list)

    @staticmethod
    def rc4_encrypt(plaintext, key):
        s = list(range(256))
        j = 0

        for i in range(256):
            j = (j + s[i] + ord(key[i % len(key)])) % 256
            s[i], s[j] = s[j], s[i]

        i = 0
        j = 0
        cipher = []

        for k in range(len(plaintext)):
            i = (i + 1) % 256
            j = (j + s[i]) % 256
            s[i], s[j] = s[j], s[i]
            t = (s[i] + s[j]) % 256
            cipher.append(chr(s[t] ^ ord(plaintext[k])))

        return ''.join(cipher)

    def get_value(self,
                  url_params: dict | str,
                  method="GET",
                  start_time=0,
                  end_time=0,
                  random_num_1=None,
                  random_num_2=None,
                  random_num_3=None,
                  ) -> str:
        string_1 = self.generate_string_1(
            random_num_1,
            random_num_2,
            random_num_3,
        )
        string_2 = self.generate_string_2(urlencode(url_params) if isinstance(
            url_params, dict) else url_params, method, start_time, end_time, )
        string = string_1 + string_2
        # return self.generate_result(
        #     string, "s4") + self.generate_result_end(string, "s4")
        return self.generate_result(string, "s4")


def extract_video_id(url):
    """Extract video ID from Douyin URL"""
    # Parse using regex pattern from tiktokdien
    parsed = re.search(
        r'https?:\/\/(www\.tiktok\.com\/@[^/]+\/video\/(\d+)|vm\.tiktok\.com\/([^/]+)\/|www\.douyin\.com\/video\/(\d+)|v\.douyin\.com\/([^/]+)\/)',
        url
    )

    if parsed:
        # Extract the video ID from the matched groups
        # Group 4 is for www.douyin.com/video/{id}
        # Group 5 is for v.douyin.com/{shortcode}/
        douyin_id = parsed.group(4) if parsed.group(4) else None
        douyin_shortcode = parsed.group(5) if parsed.group(5) else None

        if douyin_id:
            print(f"Extracted Douyin video ID: {douyin_id}", file=sys.stdout)
            return douyin_id

        if douyin_shortcode:
            print(f"Extracted Douyin shortcode: {douyin_shortcode}", file=sys.stdout)
            # For short URLs, follow the redirect to get the actual video ID
            try:
                req = urllib.request.Request(
                    url,
                    headers={
                        'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 5_1_1 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9B206 Safari/7534.48.3',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    }
                )
                response = urllib.request.urlopen(req)
                redirected_url = response.geturl()
                print(f"Redirected to: {redirected_url}", file=sys.stdout)

                # Try to extract video ID from the redirected URL
                vid_match = re.search(r'/video/(\d+)', redirected_url)
                if vid_match:
                    print(f"Extracted video ID from redirect: {vid_match.group(1)}", file=sys.stdout)
                    return vid_match.group(1)

                # Try to extract from URL parameters
                parsed_url = urllib.parse.urlparse(redirected_url)
                query_params = urllib.parse.parse_qs(parsed_url.query)
                if 'vid' in query_params:
                    print(f"Extracted video ID from query params: {query_params['vid'][0]}", file=sys.stdout)
                    return query_params['vid'][0]

                # If we can't extract from the redirected URL, return the shortcode
                return douyin_shortcode
            except Exception as e:
                print(f"Error following redirect: {str(e)}", file=sys.stderr)
                # Return the shortcode if we can't follow the redirect
                return douyin_shortcode

    # Fallback to the original extraction methods

    # For short URLs, follow the redirect first
    if 'v.douyin.com' in url:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 5_1_1 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9B206 Safari/7534.48.3',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                }
            )
            response = urllib.request.urlopen(req)
            url = response.geturl()
            print(f"Redirected to: {url}", file=sys.stdout)
        except Exception as e:
            print(f"Error following redirect: {str(e)}", file=sys.stderr)
            # Continue with the original URL

    # Try to extract from URL parameters
    parsed_url = urllib.parse.urlparse(url)
    query_params = urllib.parse.parse_qs(parsed_url.query)

    # Check if vid parameter exists
    if 'vid' in query_params:
        print(f"Extracted video ID from query params: {query_params['vid'][0]}", file=sys.stdout)
        return query_params['vid'][0]

    # Try to extract from path
    match = re.search(r'/video/(\d+)', url)
    if match:
        print(f"Extracted video ID from path: {match.group(1)}", file=sys.stdout)
        return match.group(1)

    # For short URLs, use the path component
    if 'v.douyin.com' in url:
        path = parsed_url.path.strip('/')
        if path:
            print(f"Using path component as ID: {path}", file=sys.stdout)
            return path

    print(f"Could not extract video ID from URL: {url}", file=sys.stderr)
    return None

def get_direct_video_url(video_id):
    """Get direct video URL from video ID using the method from tiktokdien"""
    # Use the API endpoint from tiktokdien
    api_url = f"https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids={video_id}"

    # Set up headers to mimic browser
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
        'Referer': 'https://www.douyin.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.douyin.com'
    }

    try:
        print(f"Trying API URL: {api_url}", file=sys.stdout)

        # Make request to API
        req = urllib.request.Request(api_url, headers=headers)
        response = urllib.request.urlopen(req, timeout=10)
        data = json.loads(response.read().decode('utf-8'))

        # Check if the API returned a success status
        if 'status_code' in data and data['status_code'] != 0:
            print(f"API returned error status: {data.get('status_msg', 'Unknown error')}", file=sys.stderr)
            return None

        # Extract video URL from response using the tiktokdien method
        if 'item_list' in data and len(data['item_list']) > 0:
            item = data['item_list'][0]

            # Try to get play address
            if 'video' in item and 'play_addr' in item['video']:
                play_addr = item['video']['play_addr']
                if 'url_list' in play_addr and len(play_addr['url_list']) > 0:
                    # Get the first URL in the list
                    play_url = play_addr['url_list'][0]

                    # Replace 'playwm' with 'play' to get the URL without watermark
                    # This is the key insight from tiktokdien
                    direct_url = play_url.replace("playwm", "play")

                    # Now we need to follow this URL to get the actual video URL
                    print(f"Following URL: {direct_url}", file=sys.stdout)

                    # Make a request to the direct URL to get the final URL
                    req = urllib.request.Request(direct_url, headers=headers)
                    response = urllib.request.urlopen(req)

                    # If the response is a redirect, get the final URL
                    if response.geturl() != direct_url:
                        final_url = response.geturl()
                        print(f"Redirected to final URL: {final_url}", file=sys.stdout)
                        return final_url

                    print(f"Using direct URL: {direct_url}", file=sys.stdout)
                    return direct_url

        print("Failed to extract video URL from API response", file=sys.stderr)

    except Exception as e:
        print(f"Error with API {api_url}: {str(e)}", file=sys.stderr)

    # If the primary method fails, try the fallback methods

    # Try multiple API endpoints
    params = {
        'device_platform': 'webapp',
        'aid': '6383',
        'channel': 'channel_pc_web',
        'pc_client_type': '1',
        'version_code': '190500',
        'version_name': '19.5.0',
        'cookie_enabled': 'true',
        'browser_language': 'zh-CN',
        'browser_platform': 'Win32',
        'browser_name': 'Chrome',
        'browser_online': 'true',
        'engine_name': 'Gecko',
        'os_name': 'Windows',
        'os_version': '10',
        'platform': 'PC',
        'screen_width': '1920',
        'screen_height': '1080',
        'browser_version': '90.0.4430.212',
        'engine_version': '122.0.0.0',
        'cpu_core_num': '12',
        'device_memory': '8',
        'aweme_id': video_id
    }
    bogus = ABogus()
    a_bogus = bogus.get_value(params)
    api_urls = [
        f"https://www.douyin.com/aweme/v1/web/aweme/detail/?{urlencode(params)}&a_bogus={quote(a_bogus)}",
        f"https://api.douyin.wtf/api?url=https://www.douyin.com/video/{video_id}",
        f"https://api.douyin.wtf/api?url=https://v.douyin.com/{video_id}"
    ]

    # Different user agents to try
    user_agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15'
    ]

    for api_url in api_urls:
        for user_agent in user_agents:
            try:
                print(f"Trying fallback API URL: {api_url} with User-Agent: {user_agent}", file=sys.stdout)

                # Set up headers to mimic browser
                headers = {
                    'User-Agent': user_agent,
                    'Referer': 'https://www.douyin.com/',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://www.douyin.com'
                }

                # Add a random delay to avoid rate limiting
                time.sleep(random.uniform(0.5, 1.5))

                # Make request to API
                req = urllib.request.Request(api_url, headers=headers)
                response = urllib.request.urlopen(req, timeout=10)
                data = json.loads(response.read().decode('utf-8'))

                # Extract video URL from response
                if 'item_list' in data and len(data['item_list']) > 0:
                    item = data['item_list'][0]

                    # Try to get play address
                    if 'video' in item and 'play_addr' in item['video']:
                        play_addr = item['video']['play_addr']
                        if 'url_list' in play_addr and len(play_addr['url_list']) > 0:
                            # Return the first URL in the list
                            direct_url = play_addr['url_list'][0].replace("playwm", "play")
                            print(f"Found direct URL: {direct_url}", file=sys.stdout)
                            return direct_url

                # Try alternative response format
                if 'aweme_detail' in data:
                    detail = data['aweme_detail']
                    if 'video' in detail and 'play_addr' in detail['video']:
                        play_addr = detail['video']['play_addr']
                        if 'url_list' in play_addr and len(play_addr['url_list']) > 0:
                            direct_url = play_addr['url_list'][0].replace("playwm", "play")
                            print(f"Found direct URL: {direct_url}", file=sys.stdout)
                            return direct_url

                # Try the third API format
                if 'status' in data and data['status'] == 'success' and 'video_data' in data:
                    video_data = data['video_data']
                    if 'nwm_video_url_HQ' in video_data:
                        direct_url = video_data['nwm_video_url_HQ']
                        print(f"Found direct URL: {direct_url}", file=sys.stdout)
                        return direct_url
                    elif 'nwm_video_url' in video_data:
                        direct_url = video_data['nwm_video_url']
                        print(f"Found direct URL: {direct_url}", file=sys.stdout)
                        return direct_url

            except Exception as e:
                print(f"Error with API {api_url}: {str(e)}", file=sys.stderr)
                continue

    print("All API methods failed, trying direct page scraping", file=sys.stdout)

    # Try direct page scraping as a last resort
    try:
        url = f"https://www.douyin.com/video/{video_id}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 5_1_1 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9B206 Safari/7534.48.3',
            'Referer': 'https://www.douyin.com/',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }

        req = urllib.request.Request(url, headers=headers)
        response = urllib.request.urlopen(req)
        html = response.read().decode('utf-8')

        # Look for video URL in the HTML
        video_url_match = re.search(r'"playAddr":\s*\[\s*"([^"]+)"', html)
        if video_url_match:
            direct_url = video_url_match.group(1).replace('\\u002F', '/').replace("playwm", "play")
            print(f"Found direct URL from HTML: {direct_url}", file=sys.stdout)
            return direct_url
    except Exception as e:
        print(f"Error with direct page scraping: {str(e)}", file=sys.stderr)

    return None

def download_with_urllib(url, output_path):
    """Download a file using urllib"""
    try:
        print(f"Downloading with urllib from: {url}", file=sys.stdout)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        }

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response, open(output_path, 'wb') as out_file:
            # Get content length for progress reporting
            content_length = response.getheader('Content-Length')
            total_size = int(content_length) if content_length else None

            # Download with progress reporting
            downloaded = 0
            block_size = 8192

            while True:
                buffer = response.read(block_size)
                if not buffer:
                    break

                downloaded += len(buffer)
                out_file.write(buffer)

                if total_size:
                    progress = int(downloaded / total_size * 100)
                    print(f"Download progress: {progress}%", file=sys.stdout)

        print(f"Download completed: {output_path}", file=sys.stdout)
        return True
    except Exception as e:
        print(f"Error downloading with urllib: {str(e)}", file=sys.stderr)
        return False

def download_with_requests(url, output_path):
    """Download a file using requests if available"""
    try:
        # Try to import requests
        import requests
        print(f"Downloading with requests from: {url}", file=sys.stdout)

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        }

        with requests.get(url, headers=headers, stream=True) as response:
            response.raise_for_status()
            total_size = int(response.headers.get('content-length', 0))

            with open(output_path, 'wb') as out_file:
                downloaded = 0
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        out_file.write(chunk)
                        downloaded += len(chunk)

                        if total_size:
                            progress = int(downloaded / total_size * 100)
                            print(f"Download progress: {progress}%", file=sys.stdout)

        print(f"Download completed: {output_path}", file=sys.stdout)
        return True
    except ImportError:
        print("Requests library not available, falling back to urllib", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error downloading with requests: {str(e)}", file=sys.stderr)
        return False

def download_with_yt_dlp(url, output_path):
    """Download a file using yt-dlp"""
    try:
        print(f"Downloading with yt-dlp from: {url}", file=sys.stdout)

        # Find yt-dlp executable
        yt_dlp_path = "yt-dlp"  # Assume yt-dlp is in PATH

        # Check if we're in a virtual environment
        if 'VIRTUAL_ENV' in os.environ:
            venv_bin = 'Scripts' if sys.platform == 'win32' else 'bin'
            venv_yt_dlp_path = os.path.join(os.environ['VIRTUAL_ENV'], venv_bin, 'yt-dlp' + ('.exe' if sys.platform == 'win32' else ''))
            if os.path.exists(venv_yt_dlp_path):
                yt_dlp_path = venv_yt_dlp_path

        # Check for yt-dlp in the current directory's .venv
        current_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.abspath(os.path.join(current_dir, '..', '..', '..'))
        venv_dir = os.path.join(root_dir, '.venv')
        if os.path.exists(venv_dir):
            venv_bin = 'Scripts' if sys.platform == 'win32' else 'bin'
            venv_yt_dlp_path = os.path.join(venv_dir, venv_bin, 'yt-dlp' + ('.exe' if sys.platform == 'win32' else ''))
            if os.path.exists(venv_yt_dlp_path):
                yt_dlp_path = venv_yt_dlp_path

        print(f"Using yt-dlp at: {yt_dlp_path}", file=sys.stdout)

        # Use subprocess instead of os.system for better error handling
        result = subprocess.run(
            [yt_dlp_path, '-o', output_path, url],
            capture_output=True,
            text=True,
            check=False
        )

        if result.returncode == 0:
            print(f"yt-dlp download successful: {output_path}", file=sys.stdout)
            return True
        else:
            print(f"yt-dlp download failed with code {result.returncode}", file=sys.stderr)
            print(f"yt-dlp stdout: {result.stdout}", file=sys.stdout)
            print(f"yt-dlp stderr: {result.stderr}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"Error downloading with yt-dlp: {str(e)}", file=sys.stderr)
        return False

def download_with_ffmpeg(url, output_path):
    """Download a file using ffmpeg"""
    try:
        print(f"Downloading with ffmpeg from: {url}", file=sys.stdout)

        # Find ffmpeg executable
        ffmpeg_path = "ffmpeg"  # Assume ffmpeg is in PATH

        # Use subprocess for better error handling
        result = subprocess.run(
            [ffmpeg_path, '-y', '-i', url, '-c', 'copy', output_path],
            capture_output=True,
            text=True,
            check=False
        )

        if result.returncode == 0:
            print(f"ffmpeg download successful: {output_path}", file=sys.stdout)
            return True
        else:
            print(f"ffmpeg download failed with code {result.returncode}", file=sys.stderr)
            print(f"ffmpeg stdout: {result.stdout}", file=sys.stdout)
            print(f"ffmpeg stderr: {result.stderr}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"Error downloading with ffmpeg: {str(e)}", file=sys.stderr)
        return False

def main():
    """Main function to extract and download Douyin video"""
    if len(sys.argv) < 3:
        print("Usage: python douyin_extractor.py <url> <output_path>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    output_path = sys.argv[2]

    print(f"Extracting video from URL: {url}", file=sys.stdout)
    print(f"Output path: {output_path}", file=sys.stdout)

    # Extract video ID
    video_id = extract_video_id(url)
    if not video_id:
        print(f"Could not extract video ID from URL: {url}", file=sys.stderr)
        sys.exit(1)

    print(f"Extracted video ID: {video_id}", file=sys.stdout)

    # Get direct video URL
    direct_url = get_direct_video_url(video_id)
    if not direct_url:
        print(f"Could not get direct video URL for ID: {video_id}", file=sys.stderr)
        sys.exit(1)

    print(f"Direct video URL: {direct_url}", file=sys.stdout)

    # Try multiple download methods in order of preference
    download_methods = [
        download_with_requests,
        download_with_urllib,
        download_with_yt_dlp,
        download_with_ffmpeg
    ]

    for download_method in download_methods:
        method_name = download_method.__name__
        print(f"Trying download method: {method_name}", file=sys.stdout)

        if download_method(direct_url, output_path):
            print(f"Download successful with {method_name}", file=sys.stdout)

            # Verify the file exists and has content
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                print(f"Verified file exists and has content: {output_path}", file=sys.stdout)
                sys.exit(0)
            else:
                print(f"File verification failed for {output_path}", file=sys.stderr)
                # Continue to next method
        else:
            print(f"Download failed with {method_name}, trying next method", file=sys.stderr)

    # If we get here, all methods failed
    print("All download methods failed", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()
