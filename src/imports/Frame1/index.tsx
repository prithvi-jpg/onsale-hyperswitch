import imgRectangle1 from "./e7cfa4e99f39b665a18a1544001546af909435e2.png";
import imgImage14 from "./11db4375d99a7b01e08eb425d59823fb5e9a9cf1.png";

function Desktop() {
  return (
    <div className="absolute bg-white h-[1024px] left-0 overflow-clip top-0 w-[1440px]" data-name="Desktop - 1">
      <p className="[word-break:break-word] absolute font-['Inter:Regular',sans-serif] font-normal leading-[normal] left-[77px] not-italic text-[#006df9] text-[24px] top-[11px] whitespace-nowrap">SEAT NERD</p>
      <div className="absolute h-[169px] left-[108px] top-[187px] w-[300px]">
        <img alt="" className="absolute inset-0 max-w-none object-cover pointer-events-none size-full" src={imgRectangle1} />
      </div>
      <div className="absolute bg-[#d9d9d9] h-[51px] left-[258px] top-[305px] w-[150px]" />
      <div className="absolute bg-[#d9d9d9] h-[169px] left-[470px] top-[187px] w-[300px]" />
      <div className="absolute bg-[#006df9] h-[51px] left-[258px] top-[305px] w-[150px]" />
      <p className="[word-break:break-word] absolute font-['Inter:Regular',sans-serif] font-normal h-[37px] leading-[normal] left-[283px] not-italic text-[15px] text-white top-[324px] w-[156px]">{`Select tickets `}</p>
      <div className="absolute h-[323px] left-[108px] top-[407px] w-[458px]" data-name="image 14">
        <img alt="" className="absolute inset-0 max-w-none object-cover pointer-events-none size-full" src={imgImage14} />
      </div>
    </div>
  );
}

export default function Frame() {
  return (
    <div className="relative size-full">
      <Desktop />
      <div className="absolute flex h-[1024px] items-center justify-center left-[48px] top-0 w-0">
        <div className="flex-none rotate-90">
          <div className="h-0 relative w-[1024px]">
            <div className="absolute inset-[-1px_0_0_0]">
              <svg className="block size-full" fill="none" height="1" preserveAspectRatio="none" viewBox="0 0 1024 1" width="1024">
                <line id="Line 1" stroke="#006DF9" x2="1024" y1="0.5" y2="0.5" />
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute flex h-[1024px] items-center justify-center left-[1022px] top-0 w-0">
        <div className="flex-none rotate-90">
          <div className="h-0 relative w-[1024px]">
            <div className="absolute inset-[-1px_0_0_0]">
              <svg className="block size-full" fill="none" height="1" preserveAspectRatio="none" viewBox="0 0 1024 1" width="1024">
                <line id="Line 1" stroke="#006DF9" x2="1024" y1="0.5" y2="0.5" />
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute h-0 left-0 top-[49px] w-[1440px]">
        <div className="absolute inset-[-1px_0_0_0]">
          <svg className="block size-full" fill="none" height="1" preserveAspectRatio="none" viewBox="0 0 1440 1" width="1440">
            <line id="Line 3" stroke="#006DF9" x2="1440" y1="0.5" y2="0.5" />
          </svg>
        </div>
      </div>
    </div>
  );
}